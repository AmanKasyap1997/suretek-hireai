import { Injectable, Logger } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { stageEvent } from '../../../shared/ta-history';
import { ApplicationStage } from '../../../shared/enums';
import {
  Busy,
  CalendarError,
  busyTimes,
  calendarConnection,
  createEvent,
  deleteEvent,
} from '../../organization-integrations/calendar';
import { InterviewSetup, interviewSetup } from '../jobs';
import { CallingClock } from './calling.clock';
import { zoneOffsetMinutes } from './call-script';
import { callingHours } from './call-setup';

/** An interview time offered on a booking call. */
export interface Slot {
  id: string;
  startsAt: string;
  endsAt: string;
  /** How the AI says it: "Tuesday 2 December at 11:00 AM". */
  label: string;
}

/** Why no interview times can be offered (a call failure code). */
export class BookingProblem extends Error {
  constructor(
    readonly failure:
      | 'no_interview_setup'
      | 'no_calendar'
      | 'calendar_auth'
      | 'calendar_permission'
      | 'calendar_unavailable'
      | 'no_interview_slots',
  ) {
    super(`No interview times: ${failure}`);
  }
}

/** Days ahead to look for interview times. */
const LOOK_AHEAD_DAYS = 14;
/** Interview starts are on the hour or half hour. */
const STEP_MINUTES = 30;

/** The local date and weekday of an instant in a time zone. */
function localDay(timezone: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

/** A local wall-clock time in a time zone, as an instant. */
function localTime(
  timezone: string,
  day: { year: number; month: number; day: number },
  minute: number,
) {
  const asUtc = Date.UTC(day.year, day.month - 1, day.day, 0, minute);
  let at = asUtc - zoneOffsetMinutes(timezone, new Date(asUtc)) * 60_000;
  // Across a clock change the offset differs at the result: use that one.
  const offset = zoneOffsetMinutes(timezone, new Date(at));
  at = asUtc - offset * 60_000;
  return new Date(at);
}

/** "Tuesday 2 December at 11:00 AM". */
export function slotLabel(timezone: string, at: Date) {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  return `${day} at ${time}`;
}

const overlaps = (start: Date, end: Date, busy: Busy[]) =>
  busy.some((b) => b.start < end && b.end > start);

/**
 * Up to `count` free interview times, from tomorrow: the earliest free time
 * on each of the first days that have one, so the candidate gets a choice of
 * days; then more on those days, at least two hours apart.
 */
export function openSlots(input: {
  setup: Pick<InterviewSetup, 'minutes' | 'days' | 'startMinute' | 'endMinute'>;
  timezone: string;
  now: Date;
  busy: Busy[];
  count?: number;
}): Slot[] {
  const { setup, timezone, now, busy } = input;
  const count = input.count ?? 3;
  const byDay: Date[][] = [];
  const today = localDay(timezone, now);
  for (let offset = 1; offset <= LOOK_AHEAD_DAYS; offset++) {
    // Noon avoids clock-change edges when stepping whole days.
    const noon = localTime(timezone, today, 12 * 60);
    const day = localDay(
      timezone,
      new Date(noon.getTime() + offset * 86_400_000),
    );
    if (!setup.days.includes(day.weekday)) continue;
    const free: Date[] = [];
    for (
      let minute = setup.startMinute;
      minute + setup.minutes <= setup.endMinute;
      minute += STEP_MINUTES
    ) {
      const start = localTime(timezone, day, minute);
      const end = new Date(start.getTime() + setup.minutes * 60_000);
      if (start > now && !overlaps(start, end, busy)) free.push(start);
    }
    if (free.length) byDay.push(free);
  }
  const chosen: Date[] = byDay.slice(0, count).map((free) => free[0]);
  for (const free of byDay.slice(0, count))
    for (const start of free) {
      if (chosen.length >= count) break;
      if (
        chosen.every(
          (c) => Math.abs(c.getTime() - start.getTime()) >= 2 * 3_600_000,
        )
      )
        chosen.push(start);
    }
  return chosen
    .sort((a, b) => a.getTime() - b.getTime())
    .map((start, i) => ({
      id: `s${i + 1}`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + setup.minutes * 60_000).toISOString(),
      label: slotLabel(timezone, start),
    }));
}

/** What booking an interview needs about an application. */
interface BookingContext {
  applicationId: string;
  jobId: string;
  stage: ApplicationStage;
  title: string;
  organization: string;
  candidate: { name: string; email: string };
  criteria: unknown;
  setup: InterviewSetup | null;
  panel: { id: string; email: string; full_name: string }[];
}

export type BookResult =
  | { booked: true; when: string; interviewId: string }
  | { booked: false; reason: 'unknown_slot' | 'taken' | 'failed' };

/**
 * Finds interview times the panel is free (in the connected calendar and in
 * HireAI) and books the one a candidate picks on the AI's booking call.
 */
@Injectable()
export class InterviewBookingService {
  private readonly logger = new Logger('InterviewBooking');

  constructor(
    private readonly db: DbService,
    private readonly clock: CallingClock,
  ) {}

  private async context(
    db: DbClient,
    tenantId: string,
    applicationId: string,
  ): Promise<BookingContext | null> {
    const row = await db.one<{
      job_id: string;
      stage: ApplicationStage;
      title: string;
      organization: string;
      full_name: string;
      email: string;
      interview_setup: unknown;
      screening_criteria: unknown;
    }>(
      `SELECT a.job_id,a.stage,j.title,t.name AS organization,c.full_name,c.email,j.interview_setup,j.screening_criteria
       FROM applications a
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.erased_at IS NULL
       JOIN tenants t ON t.id=a.tenant_id
       WHERE a.tenant_id=$1 AND a.id=$2`,
      [tenantId, applicationId],
    );
    if (!row) return null;
    const setup = interviewSetup(row.interview_setup);
    const panel = setup
      ? await db.query<{ id: string; email: string; full_name: string }>(
          `SELECT id,email,full_name FROM users
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND active`,
          [tenantId, setup.panelistIds],
        )
      : [];
    return {
      applicationId,
      jobId: row.job_id,
      stage: row.stage,
      title: row.title,
      organization: row.organization,
      candidate: { name: row.full_name, email: row.email },
      criteria: row.screening_criteria ?? [],
      setup,
      panel,
    };
  }

  /** When the panel is busy: their calendars, and their HireAI interviews. */
  private async busy(
    tenantId: string,
    context: BookingContext,
    from: Date,
    to: Date,
  ): Promise<Busy[]> {
    const connection = await calendarConnection(this.db, tenantId);
    if (!connection) throw new BookingProblem('no_calendar');
    let calendar: Busy[];
    try {
      const result = await busyTimes(
        this.db,
        connection,
        context.panel.map((p) => p.email),
        from,
        to,
      );
      calendar = result.busy;
      if (result.unreadable.length)
        this.logger.warn(
          `${result.unreadable.length} panel calendar(s) couldn't be read; only their HireAI interviews are avoided`,
        );
    } catch (error) {
      if (error instanceof CalendarError) {
        this.logger.warn(
          `The calendar couldn't be read (${error.reason}${error.detail ? `, ${error.detail}` : ''})`,
        );
        throw new BookingProblem(
          `calendar_${error.reason === 'missing' ? 'unavailable' : error.reason}`,
        );
      }
      throw error;
    }
    const interviews = await this.db.query<{ starts_at: Date; ends_at: Date }>(
      `SELECT starts_at,ends_at FROM interview_panelists
       WHERE tenant_id=$1 AND user_id=ANY($2::uuid[]) AND status='SCHEDULED'
         AND ends_at>$3 AND starts_at<$4`,
      [tenantId, context.panel.map((p) => p.id), from, to],
    );
    return [
      ...calendar,
      ...interviews.map((i) => ({ start: i.starts_at, end: i.ends_at })),
    ];
  }

  /**
   * Interview times to offer on a booking call, or a BookingProblem: no
   * setup on the job, no calendar, or no free time in the next two weeks.
   */
  async offer(tenantId: string, applicationId: string): Promise<Slot[]> {
    const context = await this.context(this.db, tenantId, applicationId);
    if (!context?.setup || !context.panel.length)
      throw new BookingProblem('no_interview_setup');
    const hours = await callingHours(this.db);
    const timezone = hours?.timezone ?? 'Asia/Kolkata';
    const now = this.clock.now();
    const busy = await this.busy(
      tenantId,
      context,
      now,
      new Date(now.getTime() + (LOOK_AHEAD_DAYS + 1) * 86_400_000),
    );
    const slots = openSlots({ setup: context.setup, timezone, now, busy });
    if (!slots.length) throw new BookingProblem('no_interview_slots');
    return slots;
  }

  /**
   * Books the time the candidate picked on the call: an event in the
   * connected calendar inviting the panel and the candidate (the calendar
   * emails them), and the interview in HireAI.
   */
  async book(
    tenantId: string,
    attemptId: string,
    slotId: string,
  ): Promise<BookResult> {
    const attempt = await this.db.one<{
      application_id: string;
      slots: Slot[] | null;
      booked_interview_id: string | null;
    }>(
      `SELECT cr.application_id,ca.slots,ca.booked_interview_id FROM call_attempts ca
       JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       WHERE ca.tenant_id=$1 AND ca.id=$2`,
      [tenantId, attemptId],
    );
    const slot = attempt?.slots?.find((s) => s.id === slotId);
    if (!attempt || !slot) return { booked: false, reason: 'unknown_slot' };
    if (attempt.booked_interview_id)
      return {
        booked: true,
        when: slot.label,
        interviewId: attempt.booked_interview_id,
      };
    const context = await this.context(
      this.db,
      tenantId,
      attempt.application_id,
    );
    if (!context?.setup || !context.panel.length)
      return { booked: false, reason: 'failed' };
    const setup = context.setup;
    const start = new Date(slot.startsAt);
    const end = new Date(slot.endsAt);
    try {
      // Taken since it was offered?
      if (overlaps(start, end, await this.busy(tenantId, context, start, end)))
        return { booked: false, reason: 'taken' };
    } catch (error) {
      this.logger.warn(`Couldn't check the interview time (${String(error)})`);
      return { booked: false, reason: 'failed' };
    }
    const connection = await calendarConnection(this.db, tenantId);
    if (!connection) return { booked: false, reason: 'failed' };
    let event: { id: string; meetingUrl: string | null };
    try {
      event = await createEvent(this.db, connection, {
        title: `${setup.round}: ${context.candidate.name} · ${context.title}`,
        description: `${setup.round} interview for ${context.title} at ${context.organization}, booked by HireAI's AI assistant with the candidate.`,
        start,
        end,
        attendees: [
          ...context.panel.map((p) => ({ email: p.email, name: p.full_name })),
          { email: context.candidate.email, name: context.candidate.name },
        ],
        online: setup.mode === 'VIDEO',
        location: setup.mode === 'ONSITE' ? (setup.location ?? null) : null,
      });
    } catch (error) {
      this.logger.warn(
        `The calendar event couldn't be created (${error instanceof CalendarError ? error.reason : 'error'})`,
      );
      return { booked: false, reason: 'failed' };
    }
    try {
      const interviewId = await this.db.transaction(async (tx) => {
        const interview = await tx.one<{
          id: string;
          starts_at: Date;
          ends_at: Date;
          status: string;
        }>(
          `INSERT INTO interviews (tenant_id,application_id,round,mode,starts_at,ends_at,location,meeting_url,criteria_snapshot,created_by,calendar_provider,calendar_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11) RETURNING id,starts_at,ends_at,status`,
          [
            tenantId,
            context.applicationId,
            setup.round,
            setup.mode,
            start,
            end,
            setup.mode === 'ONSITE' ? (setup.location ?? null) : null,
            event.meetingUrl,
            JSON.stringify(
              Array.isArray(context.criteria) ? context.criteria : [],
            ),
            connection.provider,
            event.id,
          ],
        );
        // The panel's reservations: an overlap fails the booking (23P01).
        await tx.query(
          `INSERT INTO interview_panelists (tenant_id,interview_id,user_id,starts_at,ends_at,status)
           SELECT $1,$2,panelist,$4,$5,$6 FROM unnest($3::uuid[]) panelist`,
          [
            tenantId,
            interview!.id,
            context.panel.map((p) => p.id),
            interview!.starts_at,
            interview!.ends_at,
            interview!.status,
          ],
        );
        await tx.query(
          'UPDATE call_attempts SET booked_interview_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, attemptId, interview!.id],
        );
        const system = { tenantId, userId: null };
        if (context.stage === ApplicationStage.SHORTLISTED) {
          await tx.query(
            "UPDATE applications SET stage='INTERVIEW',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND stage='SHORTLISTED'",
            [tenantId, context.applicationId],
          );
          await stageEvent(
            tx,
            system,
            context.applicationId,
            ApplicationStage.SHORTLISTED,
            ApplicationStage.INTERVIEW,
            undefined,
            'Automatic: the candidate booked an interview on the AI call',
          );
        }
        await audit(
          tx,
          system,
          'interview.booked_by_call',
          'interview',
          interview!.id,
          {
            applicationId: context.applicationId,
            attemptId,
            calendar: connection.provider,
          },
        );
        return interview!.id;
      });
      return { booked: true, when: slot.label, interviewId };
    } catch (error) {
      // Not booked in HireAI: take the invitation back.
      await deleteEvent(this.db, connection, event.id).catch(() => undefined);
      if ((error as { code?: string })?.code === '23P01')
        return { booked: false, reason: 'taken' };
      this.logger.warn(`The interview couldn't be saved (${String(error)})`);
      return { booked: false, reason: 'failed' };
    }
  }
}
