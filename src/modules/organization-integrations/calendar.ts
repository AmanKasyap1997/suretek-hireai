import { randomUUID } from 'node:crypto';
import { DbClient } from '../../platform/database/db.service';
import { decryptSecret, encryptSecret } from '../super-admin/secrets';
import { Method } from './catalog';
import { effectiveCredentials } from './hosted-oauth';
import { providerAuth } from './provider-client';

export type CalendarProvider = 'google_calendar' | 'microsoft_calendar';

/** Why a calendar couldn't be used. */
export type CalendarFailure =
  | 'auth' // the connection must be authorized again
  | 'permission' // it lacks a permission HireAI needs (e.g. free/busy)
  | 'unavailable' // the provider couldn't be reached
  | 'missing'; // the event was deleted in the calendar

export class CalendarError extends Error {
  constructor(
    readonly reason: CalendarFailure,
    /** For the server log: an HTTP status, never response text. */
    readonly detail = '',
  ) {
    super(`Calendar unavailable: ${reason}`);
  }
}

/** The organization's enabled calendar connection. */
export interface CalendarConnection {
  id: string;
  tenantId: string;
  provider: CalendarProvider;
  environment: string;
  method: Method;
  encrypted: string;
}

export interface Busy {
  start: Date;
  end: Date;
}

export interface CalendarEvent {
  title: string;
  description: string;
  start: Date;
  end: Date;
  /** Invited by the calendar provider, which emails them the invitation. */
  attendees: { email: string; name?: string }[];
  /** A Google Meet or Teams link is added. */
  online: boolean;
  location?: string | null;
}

const TIMEOUT_MS = 15_000;

/**
 * The organization's enabled calendars, one per provider: first the one an
 * HR Admin chose for interviews (else production before sandbox, Google
 * before Microsoft).
 */
export async function calendarConnections(
  db: DbClient,
  tenantId: string,
): Promise<CalendarConnection[]> {
  const rows = await db.query<{
    id: string;
    provider: CalendarProvider;
    environment: string;
    method: Method;
    encrypted_credentials: string;
  }>(
    `SELECT c.id,c.provider,c.environment,c.method,c.encrypted_credentials
     FROM integration_configs c
     JOIN integration_providers p ON p.provider=c.provider AND p.enabled AND p.revision=c.provider_revision
     LEFT JOIN organization_ai_settings s ON s.tenant_id=c.tenant_id
     WHERE c.tenant_id=$1 AND c.organization_id=$1
       AND c.provider IN ('google_calendar','microsoft_calendar')
       AND c.status='enabled' AND c.encrypted_credentials<>''
     ORDER BY (c.provider IS NOT DISTINCT FROM s.interview_calendar) DESC,
       (c.environment='production') DESC,(c.provider='google_calendar') DESC,c.id`,
    [tenantId],
  );
  const seen = new Set<CalendarProvider>();
  return rows
    .filter((row) => !seen.has(row.provider) && !!seen.add(row.provider))
    .map((row) => ({
      id: row.id,
      tenantId,
      provider: row.provider,
      environment: row.environment,
      method: row.method,
      encrypted: row.encrypted_credentials,
    }));
}

/**
 * The calendar interviews go in (see calendarConnections), or the given
 * provider's; null when it isn't connected.
 */
export async function calendarConnection(
  db: DbClient,
  tenantId: string,
  provider?: CalendarProvider | null,
): Promise<CalendarConnection | null> {
  const all = await calendarConnections(db, tenantId);
  return (provider ? all.find((c) => c.provider === provider) : all[0]) ?? null;
}

/**
 * Request headers for the calendar, refreshing its token, and saving rotated
 * tokens (unless the connection changed meanwhile).
 */
async function headers(db: DbClient, connection: CalendarConnection) {
  const context = [
    'organization',
    connection.tenantId,
    connection.provider,
    connection.environment,
  ].join(':');
  let stored: Record<string, string>;
  try {
    stored = JSON.parse(decryptSecret(connection.encrypted, context));
  } catch {
    throw new CalendarError('auth', 'credentials unreadable');
  }
  let auth: Awaited<ReturnType<typeof providerAuth>>;
  try {
    auth = await providerAuth(
      connection.provider,
      connection.method,
      effectiveCredentials(connection.provider, stored),
    );
  } catch {
    throw new CalendarError('auth', 'token refresh failed');
  }
  const rotated = { ...auth.credentials };
  if (rotated._hosted === 'true') delete rotated.clientSecret;
  if (JSON.stringify(rotated) !== JSON.stringify(stored)) {
    const encrypted = encryptSecret(JSON.stringify(rotated), context);
    await db.query(
      'UPDATE integration_configs SET encrypted_credentials=$3 WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$4',
      [connection.tenantId, connection.id, encrypted, connection.encrypted],
    );
    connection.encrypted = encrypted;
  }
  return { ...auth.headers, 'Content-Type': 'application/json' };
}

async function send(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CalendarError('unavailable', 'no response');
  }
  if (response.ok) return response;
  await response.body?.cancel().catch(() => undefined);
  throw new CalendarError(
    response.status === 401
      ? 'auth'
      : response.status === 403
        ? 'permission'
        : 'unavailable',
    `HTTP ${response.status}`,
  );
}

/** Microsoft's UTC date-time without an offset ("2026-11-26T09:00:00"). */
const graphTime = (at: Date) => at.toISOString().slice(0, 19);
const fromGraph = (value: unknown) =>
  typeof value === 'string' ? new Date(`${value.replace(/Z$/, '')}Z`) : null;

/**
 * When the connected account and these people are busy. People whose
 * calendars can't be read (outside the organization's Google Workspace or
 * Microsoft 365) are returned as `unreadable`.
 */
export async function busyTimes(
  db: DbClient,
  connection: CalendarConnection,
  emails: string[],
  from: Date,
  to: Date,
): Promise<{ busy: Busy[]; unreadable: string[] }> {
  const auth = await headers(db, connection);
  const busy: Busy[] = [];
  const unreadable: string[] = [];
  const add = (start: unknown, end: unknown) => {
    const s =
      start instanceof Date
        ? start
        : new Date(typeof start === 'string' ? start : NaN);
    const e =
      end instanceof Date ? end : new Date(typeof end === 'string' ? end : NaN);
    if (Number.isFinite(s.getTime()) && Number.isFinite(e.getTime()))
      busy.push({ start: s, end: e });
  };
  if (connection.provider === 'google_calendar') {
    const response = await send(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: 'primary' }, ...emails.map((id) => ({ id }))],
        }),
      },
    );
    const data = (await response.json().catch(() => null)) as {
      calendars?: Record<
        string,
        { busy?: { start?: unknown; end?: unknown }[]; errors?: unknown[] }
      >;
    } | null;
    if (!data?.calendars) throw new CalendarError('unavailable', 'no data');
    for (const [id, calendar] of Object.entries(data.calendars)) {
      if (calendar.errors?.length) {
        if (id === 'primary') throw new CalendarError('permission', 'primary');
        unreadable.push(id);
        continue;
      }
      for (const slot of calendar.busy ?? []) add(slot.start, slot.end);
    }
    return { busy, unreadable };
  }
  // Microsoft: the connected account's own events, then the panel's.
  const own = await send(
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=start,end,showAs&$top=500`,
    { headers: { ...auth, Prefer: 'outlook.timezone="UTC"' } },
  );
  const events = (await own.json().catch(() => null)) as {
    value?: {
      showAs?: string;
      start?: { dateTime?: unknown };
      end?: { dateTime?: unknown };
    }[];
  } | null;
  for (const event of events?.value ?? [])
    if (event.showAs !== 'free' && event.showAs !== 'workingElsewhere')
      add(fromGraph(event.start?.dateTime), fromGraph(event.end?.dateTime));
  if (emails.length) {
    const schedule = await send(
      'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
      {
        method: 'POST',
        headers: { ...auth, Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({
          schedules: emails,
          startTime: { dateTime: graphTime(from), timeZone: 'UTC' },
          endTime: { dateTime: graphTime(to), timeZone: 'UTC' },
          availabilityViewInterval: 30,
        }),
      },
    );
    const data = (await schedule.json().catch(() => null)) as {
      value?: {
        scheduleId?: string;
        error?: unknown;
        scheduleItems?: {
          status?: string;
          start?: { dateTime?: unknown };
          end?: { dateTime?: unknown };
        }[];
      }[];
    } | null;
    for (const person of data?.value ?? []) {
      if (person.error) {
        if (person.scheduleId) unreadable.push(person.scheduleId);
        continue;
      }
      for (const item of person.scheduleItems ?? [])
        if (item.status !== 'free' && item.status !== 'workingElsewhere')
          add(fromGraph(item.start?.dateTime), fromGraph(item.end?.dateTime));
    }
  }
  return { busy, unreadable };
}

/** The provider's request body for an event. */
function eventBody(provider: CalendarProvider, event: CalendarEvent) {
  if (provider === 'google_calendar')
    return {
      summary: event.title,
      description: event.description,
      start: { dateTime: event.start.toISOString() },
      end: { dateTime: event.end.toISOString() },
      attendees: event.attendees.map((a) => ({
        email: a.email,
        ...(a.name ? { displayName: a.name } : {}),
      })),
      // An empty location clears one set before.
      location: event.location ?? '',
      ...(event.online
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }
        : {}),
      guestsCanModify: false,
      reminders: { useDefault: true },
    };
  return {
    subject: event.title,
    body: { contentType: 'text', content: event.description },
    start: { dateTime: graphTime(event.start), timeZone: 'UTC' },
    end: { dateTime: graphTime(event.end), timeZone: 'UTC' },
    attendees: event.attendees.map((a) => ({
      emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
      type: 'required',
    })),
    location: { displayName: event.location ?? '' },
    ...(event.online
      ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
      : {}),
    allowNewTimeProposals: false,
  };
}

/** A saved event: its id, Meet or Teams link, and the account it's from. */
export interface SavedEvent {
  id: string;
  meetingUrl: string | null;
  /** The calendar account that sent the invitations. */
  organizer: string | null;
}

async function savedEvent(
  provider: CalendarProvider,
  response: Response,
): Promise<SavedEvent> {
  const data = (await response.json().catch(() => null)) as {
    id?: unknown;
    hangoutLink?: unknown;
    conferenceData?: {
      entryPoints?: { entryPointType?: string; uri?: unknown }[];
    };
    onlineMeeting?: { joinUrl?: unknown } | null;
    organizer?: { email?: unknown; emailAddress?: { address?: unknown } };
  } | null;
  if (typeof data?.id !== 'string')
    throw new CalendarError('unavailable', 'no event id');
  const link =
    provider === 'google_calendar'
      ? typeof data.hangoutLink === 'string'
        ? data.hangoutLink
        : data.conferenceData?.entryPoints?.find(
            (e) => e.entryPointType === 'video',
          )?.uri
      : data.onlineMeeting?.joinUrl;
  const organizer =
    provider === 'google_calendar'
      ? data.organizer?.email
      : data.organizer?.emailAddress?.address;
  return {
    id: data.id,
    meetingUrl:
      typeof link === 'string' && link.startsWith('https://') ? link : null,
    organizer: typeof organizer === 'string' ? organizer : null,
  };
}

/**
 * Sends an event. Microsoft refuses a Teams meeting for accounts without
 * Teams (personal Outlook accounts): the event is then sent without one.
 */
async function sendEvent(
  connection: CalendarConnection,
  url: string,
  method: 'POST' | 'PATCH',
  auth: Record<string, string>,
  event: CalendarEvent,
): Promise<SavedEvent> {
  const request = (body: CalendarEvent) =>
    send(url, {
      method,
      headers: auth,
      body: JSON.stringify(eventBody(connection.provider, body)),
    });
  let response: Response;
  try {
    response = await request(event);
  } catch (error) {
    if (
      connection.provider === 'microsoft_calendar' &&
      event.online &&
      error instanceof CalendarError &&
      error.detail === 'HTTP 400'
    )
      response = await request({ ...event, online: false });
    else throw error;
  }
  return savedEvent(connection.provider, response);
}

/**
 * Adds the event to the connected calendar and invites the attendees (the
 * provider emails them). Returns its id and the Meet or Teams link.
 */
export async function createEvent(
  db: DbClient,
  connection: CalendarConnection,
  event: CalendarEvent,
): Promise<SavedEvent> {
  const auth = await headers(db, connection);
  return sendEvent(
    connection,
    connection.provider === 'google_calendar'
      ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all'
      : 'https://graph.microsoft.com/v1.0/me/events',
    'POST',
    auth,
    event,
  );
}

/**
 * Changes an event in the connected calendar; the provider tells the
 * attendees. `online` adds a Meet or Teams link. A CalendarError with
 * `missing` means the event is no longer there.
 */
export async function updateEvent(
  db: DbClient,
  connection: CalendarConnection,
  id: string,
  event: CalendarEvent,
): Promise<SavedEvent> {
  const auth = await headers(db, connection);
  try {
    return await sendEvent(
      connection,
      connection.provider === 'google_calendar'
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?conferenceDataVersion=1&sendUpdates=all`
        : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`,
      'PATCH',
      auth,
      event,
    );
  } catch (error) {
    if (
      error instanceof CalendarError &&
      (error.detail === 'HTTP 404' || error.detail === 'HTTP 410')
    )
      throw new CalendarError('missing', error.detail);
    throw error;
  }
}

/** Removes an event (and tells its attendees). Best effort. */
export async function deleteEvent(
  db: DbClient,
  connection: CalendarConnection,
  id: string,
) {
  const auth = await headers(db, connection);
  await send(
    connection.provider === 'google_calendar'
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`
      : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: auth },
  );
}
