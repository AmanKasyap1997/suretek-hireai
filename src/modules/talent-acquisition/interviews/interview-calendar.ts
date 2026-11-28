import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { InterviewMode, InterviewStatus } from '../../../shared/enums';
import {
  CalendarConnection,
  CalendarError,
  CalendarEvent,
  CalendarFailure,
  CalendarProvider,
  SavedEvent,
  calendarConnection,
  calendarConnections,
  createEvent,
  deleteEvent,
  updateEvent,
} from '../../organization-integrations/calendar';

/** Why someone invited may not get an email, though the event was saved. */
export type CalendarWarning =
  /** The candidate's address is the calendar's own account. */
  | 'candidate_is_organizer'
  /** A video interview, but the calendar couldn't create a meeting. */
  | 'no_meeting_link';

/** What happened in the organization's calendar. */
export type CalendarSync =
  | {
      /** Moved: added to another calendar, and taken off the old one. */
      status: 'added' | 'updated' | 'moved';
      provider: CalendarProvider;
      /** The calendar account the invitations come from. */
      organizer: string | null;
      /** The candidate's address it invited, and how many panelists. */
      candidate: string | null;
      panel: number;
      warnings: CalendarWarning[];
    }
  /** Scheduled without invitations. */
  | { status: 'not_sent' }
  | { status: 'not_connected' }
  | { status: 'failed'; provider: CalendarProvider; problem: CalendarFailure };

export const calendarNames: Record<CalendarProvider, string> = {
  google_calendar: 'Google Calendar',
  microsoft_calendar: 'Microsoft Calendar',
};

/** A Meet or Teams link the calendar created (not one of the recruiter's). */
function calendarLink(url: string, provider: CalendarProvider | null) {
  const host = new URL(url).hostname;
  return provider === 'google_calendar'
    ? host === 'meet.google.com'
    : provider === 'microsoft_calendar'
      ? host === 'teams.microsoft.com' || host === 'teams.live.com'
      : false;
}

const modeLabels: Record<InterviewMode, string> = {
  VIDEO: 'Video call',
  PHONE: 'Phone call',
  ONSITE: 'Onsite',
};

/**
 * Keeps interviews in the organization's connected Google or Microsoft
 * calendar. The event invites the panel and the candidate, so it appears in
 * their calendars too, and the provider emails them about every change.
 */
@Injectable()
export class InterviewCalendarService {
  private readonly logger = new Logger('InterviewCalendar');

  constructor(private readonly db: DbService) {}

  /** The calendar interviews go in, if any. */
  async provider(tenantId: string): Promise<CalendarProvider | null> {
    return (await calendarConnection(this.db, tenantId))?.provider ?? null;
  }

  /** The calendar interviews go in, and every connected one. */
  async status(tenantId: string) {
    const all = await calendarConnections(this.db, tenantId);
    return {
      provider: all[0]?.provider ?? null,
      connected: all.map((c) => c.provider),
    };
  }

  /**
   * Fails unless a calendar is connected (the given one, if any): before
   * scheduling with invitations.
   */
  async assertConnected(tenantId: string, provider?: CalendarProvider) {
    const { connected } = await this.status(tenantId);
    if (!connected.length)
      throw new ConflictException(
        'Connect Google Calendar or Microsoft Calendar in Integrations to send invitations.',
      );
    if (provider && !connected.includes(provider))
      throw new ConflictException(
        `${calendarNames[provider]} isn’t connected. Connect it in Integrations.`,
      );
  }

  /** An HR Admin chooses the calendar interviews go in. */
  async choose(actor: Actor, provider: CalendarProvider) {
    await this.assertConnected(actor.tenantId, provider);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO organization_ai_settings(tenant_id,interview_calendar,updated_by)
         VALUES($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET interview_calendar=EXCLUDED.interview_calendar,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [actor.tenantId, provider, actor.userId],
      );
      await audit(
        tx,
        actor,
        'organization.interview_calendar_updated',
        'organization',
        actor.tenantId,
        { provider },
      );
    });
    return this.status(actor.tenantId);
  }

  /**
   * Adds the interview to a calendar (the given one, else the one it's in,
   * else the organization's), or updates its event there. In another
   * calendar than before, it moves: the old event is cancelled. A video
   * interview without a link gets a Meet or Teams link. Never throws: a
   * problem is returned, and the interview stays scheduled in HireAI.
   */
  async sync(
    tenantId: string,
    interviewId: string,
    requested?: CalendarProvider,
  ): Promise<CalendarSync> {
    const all = await calendarConnections(this.db, tenantId);
    if (!all.length) return { status: 'not_connected' };
    let provider = requested ?? all[0].provider;
    try {
      const row = await this.db.one<{
        round: string;
        mode: InterviewMode;
        starts_at: Date;
        ends_at: Date;
        location: string | null;
        meeting_url: string | null;
        status: InterviewStatus;
        calendar_provider: CalendarProvider | null;
        calendar_event_id: string | null;
        job_title: string;
        organization: string;
        candidate_name: string;
        candidate_email: string | null;
      }>(
        `SELECT i.round,i.mode,i.starts_at,i.ends_at,i.location,i.meeting_url,i.status,
                i.calendar_provider,i.calendar_event_id,j.title AS job_title,t.name AS organization,
                c.full_name AS candidate_name,c.email AS candidate_email
         FROM interviews i
         JOIN applications a ON a.tenant_id=i.tenant_id AND a.id=i.application_id
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.erased_at IS NULL
         JOIN tenants t ON t.id=i.tenant_id
         WHERE i.tenant_id=$1 AND i.id=$2`,
        [tenantId, interviewId],
      );
      if (!row || row.status !== InterviewStatus.SCHEDULED)
        return { status: 'failed', provider, problem: 'missing' };
      // Already in a connected calendar: it stays there unless asked.
      const current = row.calendar_event_id
        ? all.find((c) => c.provider === row.calendar_provider)
        : undefined;
      if (!requested && current) provider = current.provider;
      const target = all.find((c) => c.provider === provider);
      if (!target) return { status: 'failed', provider, problem: 'auth' };
      const moving =
        !!row.calendar_event_id && provider !== row.calendar_provider;
      const panel = await this.db.query<{ email: string; full_name: string }>(
        `SELECT u.email,u.full_name FROM interview_panelists p
         JOIN users u ON u.tenant_id=p.tenant_id AND u.id=p.user_id
         WHERE p.tenant_id=$1 AND p.interview_id=$2 ORDER BY u.full_name,u.id`,
        [tenantId, interviewId],
      );
      const video = row.mode === InterviewMode.VIDEO;
      // Moving: the new calendar creates a link to replace the old one's.
      const link =
        moving &&
        row.meeting_url &&
        calendarLink(row.meeting_url, row.calendar_provider)
          ? null
          : row.meeting_url;
      const event: CalendarEvent = {
        title: `${row.round}: ${row.candidate_name} · ${row.job_title}`,
        description: [
          `${row.round} interview for ${row.job_title} at ${row.organization}.`,
          '',
          `Candidate: ${row.candidate_name}`,
          `Type: ${modeLabels[row.mode]}`,
          ...(video && link ? [`Join: ${link}`] : []),
          ...(row.mode === InterviewMode.ONSITE && row.location
            ? [`Location: ${row.location}`]
            : []),
          ...(panel.length
            ? [`Interview panel: ${panel.map((p) => p.full_name).join(', ')}`]
            : []),
        ].join('\n'),
        start: new Date(row.starts_at),
        end: new Date(row.ends_at),
        attendees: [
          ...panel.map((p) => ({ email: p.email, name: p.full_name })),
          ...(row.candidate_email
            ? [{ email: row.candidate_email, name: row.candidate_name }]
            : []),
        ],
        // No link of its own: the calendar creates a Meet or Teams link.
        online: video && !link,
        location:
          row.mode === InterviewMode.ONSITE
            ? row.location
            : video
              ? link
              : null,
      };
      let saved: SavedEvent;
      let status: 'added' | 'updated' | 'moved' = moving ? 'moved' : 'added';
      if (row.calendar_event_id && !moving)
        try {
          saved = await updateEvent(
            this.db,
            target,
            row.calendar_event_id,
            event,
          );
          status = 'updated';
        } catch (error) {
          // Deleted in the calendar: add it again.
          if (!(error instanceof CalendarError && error.reason === 'missing'))
            throw error;
          saved = await createEvent(this.db, target, event);
        }
      else saved = await createEvent(this.db, target, event);
      const kept = await this.db.query(
        `UPDATE interviews SET calendar_provider=$3,calendar_event_id=$4,
           meeting_url=CASE WHEN mode<>'VIDEO' THEN meeting_url
             WHEN $7 THEN coalesce($5,meeting_url)
             ELSE coalesce(meeting_url,$5) END,
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='SCHEDULED'
           AND calendar_event_id IS NOT DISTINCT FROM $6
         RETURNING id`,
        [
          tenantId,
          interviewId,
          provider,
          saved.id,
          saved.meetingUrl,
          row.calendar_event_id,
          moving && !link,
        ],
      );
      if (!kept.length) {
        // Cancelled, or added by someone else, meanwhile: take this one back.
        if (saved.id !== row.calendar_event_id)
          await deleteEvent(this.db, target, saved.id).catch(() => undefined);
      } else if (moving && current && row.calendar_event_id)
        // Off the old calendar; its attendees are told.
        await this.deleteQuietly(current, row.calendar_event_id);
      const warnings: CalendarWarning[] = [];
      if (
        saved.organizer &&
        row.candidate_email &&
        saved.organizer.toLowerCase() === row.candidate_email.toLowerCase()
      )
        warnings.push('candidate_is_organizer');
      if (video && !link && !saved.meetingUrl && !row.meeting_url)
        warnings.push('no_meeting_link');
      return {
        status,
        provider,
        organizer: saved.organizer,
        candidate: row.candidate_email,
        panel: panel.length,
        warnings,
      };
    } catch (error) {
      const problem: CalendarFailure =
        error instanceof CalendarError ? error.reason : 'unavailable';
      this.logger.warn(
        `An interview couldn't be put in ${provider} (${problem}${error instanceof CalendarError && error.detail ? `, ${error.detail}` : ''})`,
      );
      return { status: 'failed', provider, problem };
    }
  }

  private async deleteQuietly(connection: CalendarConnection, id: string) {
    await deleteEvent(this.db, connection, id).catch((error: unknown) =>
      this.logger.warn(
        `An interview's old calendar event couldn't be removed (${error instanceof CalendarError ? error.reason : 'error'})`,
      ),
    );
  }

  /** Takes a cancelled interview off its calendar; attendees are told. */
  async remove(tenantId: string, interviewId: string) {
    const row = await this.db.one<{
      calendar_provider: CalendarProvider | null;
      calendar_event_id: string | null;
    }>(
      'SELECT calendar_provider,calendar_event_id FROM interviews WHERE tenant_id=$1 AND id=$2',
      [tenantId, interviewId],
    );
    if (!row?.calendar_event_id || !row.calendar_provider) return;
    const connection = await calendarConnection(
      this.db,
      tenantId,
      row.calendar_provider,
    );
    if (connection) await this.deleteQuietly(connection, row.calendar_event_id);
  }
}
