import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { audit } from '../../../platform/audit/audit';
import { Actor } from '../../../shared/actor';
import {
  ApplicationStage,
  InterviewMode,
  InterviewStatus,
} from '../../../shared/enums';
import {
  AccessPolicy,
  INTERVIEW_ROLES,
  InterviewAccessRecord,
  ScreeningCriterion,
  isScoped,
} from '../../../shared/ta-policy';
import {
  CreateInterviewInput,
  InterviewListInput,
  RescheduleInterviewInput,
} from './interviews.schemas';
import { CalendarSync, InterviewCalendarService } from './interview-calendar';
import { CalendarProvider } from '../../organization-integrations/calendar';

/**
 * An interview with what the screens show: the candidate and job, the panel's
 * names, feedback so far and whether it's in the calendar. `$1` is the
 * organization and `$${me}` the person asking.
 */
const details = (me: number) => `
  SELECT i.*,(i.calendar_event_id IS NOT NULL) AS on_calendar,
    a.job_id,a.stage AS application_stage,j.title AS job_title,
    CASE WHEN c.erased_at IS NULL THEN c.full_name END AS candidate_name,
    ARRAY(SELECT panel.user_id FROM interview_panelists panel
      WHERE panel.tenant_id=$1 AND panel.interview_id=i.id ORDER BY panel.user_id) AS panelist_ids,
    coalesce((SELECT json_agg(json_build_object('id',u.id,'full_name',u.full_name,'role',u.role) ORDER BY u.full_name,u.id)
      FROM interview_panelists panel JOIN users u ON u.tenant_id=panel.tenant_id AND u.id=panel.user_id
      WHERE panel.tenant_id=$1 AND panel.interview_id=i.id),'[]'::json) AS panel,
    (SELECT count(*)::int FROM interview_scorecards s
      WHERE s.tenant_id=$1 AND s.interview_id=i.id) AS scorecard_count,
    EXISTS (SELECT 1 FROM interview_scorecards s
      WHERE s.tenant_id=$1 AND s.interview_id=i.id AND s.panelist_user_id=$${me}) AS my_scorecard,
    creator.full_name AS created_by_name
  FROM interviews i
  JOIN applications a ON a.tenant_id=i.tenant_id AND a.id=i.application_id
  JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
  JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
  LEFT JOIN users creator ON creator.tenant_id=i.tenant_id AND creator.id=i.created_by`;

type InterviewDetails = InterviewAccessRecord & {
  panelist_ids: string[];
  scorecard_count: number | null;
};

@Injectable()
export class InterviewsService {
  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
    private readonly calendar: InterviewCalendarService,
  ) {}

  /** The calendar interviews go in, and every connected one. */
  async calendarStatus(actor: Actor) {
    this.policy.assertInterviewManager(actor);
    return this.calendar.status(actor.tenantId);
  }

  /** An HR Admin chooses the calendar interviews go in. */
  chooseCalendar(actor: Actor, provider: CalendarProvider) {
    return this.calendar.choose(actor, provider);
  }

  /**
   * One interview's details. Panelists who aren't recruiters see only their
   * own feedback, so not how many others gave theirs.
   */
  private async details(db: DbClient, actor: Actor, id: string) {
    const row = await db.one<InterviewDetails>(
      `${details(3)} WHERE i.tenant_id=$1 AND i.id=$2`,
      [actor.tenantId, id, actor.userId],
    );
    if (!row) throw new NotFoundException('Interview not found.');
    return this.visible(actor, row);
  }

  private visible(actor: Actor, row: InterviewDetails): InterviewDetails {
    return isScoped(actor) ? { ...row, scorecard_count: null } : row;
  }

  /**
   * The people who can sit on an interview panel (the same rule as
   * scheduling applies), for choosing them.
   */
  async panelists(actor: Actor) {
    this.policy.assertInterviewManager(actor);
    const data = await this.db.query<{
      id: string;
      full_name: string;
      role: string;
    }>(
      `SELECT id,full_name,role FROM users
       WHERE tenant_id=$1 AND active AND role=ANY($2::text[]) ORDER BY full_name,id`,
      [actor.tenantId, INTERVIEW_ROLES],
    );
    return { data };
  }

  private async lockTenant(db: DbClient, actor: Actor) {
    // User status changes lock tenant before users; keep the same order before
    // panel user locks and the tenant/user foreign keys of new audit rows.
    await db.query('SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE', [
      actor.tenantId,
    ]);
  }

  private async eligibleApplication(db: DbClient, actor: Actor, id: string) {
    const application = await db.one<{
      id: string;
      job_id: string;
      candidate_id: string;
      stage: ApplicationStage;
    }>(
      'SELECT id,job_id,candidate_id,stage FROM applications WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [actor.tenantId, id],
    );
    if (!application) throw new NotFoundException('Application not found.');
    if (
      application.stage !== ApplicationStage.SHORTLISTED &&
      application.stage !== ApplicationStage.INTERVIEW
    )
      throw new ConflictException(
        'Only shortlisted or interviewing applications can be scheduled.',
      );
    // Match hiring and erasure lock order: application before candidate.
    const candidate = await db.one<{ id: string }>(
      'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 AND erased_at IS NULL FOR SHARE',
      [actor.tenantId, application.candidate_id],
    );
    if (!candidate) throw new NotFoundException('Candidate not found.');
    return application;
  }

  private validateSchedule(startsAt: string, endsAt: string) {
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new BadRequestException('Interview end must be after its start.');
    if (end - start > 24 * 60 * 60 * 1000)
      throw new BadRequestException('An interview may last at most 24 hours.');
    if (start <= Date.now())
      throw new BadRequestException('Interview start must be in the future.');
  }

  private validateVenue(
    mode: InterviewMode,
    location: string | null,
    meetingUrl: string | null,
    /** The calendar creates a Meet or Teams link. */
    calendarLink = false,
  ) {
    if (mode === InterviewMode.VIDEO && !meetingUrl && !calendarLink)
      throw new BadRequestException(
        'Video interviews require a meeting URL, or a calendar invitation to create one.',
      );
    if (mode === InterviewMode.ONSITE && !location)
      throw new BadRequestException('Onsite interviews require a location.');
  }

  private schedulingError(error: unknown): never {
    const code = (error as { code?: string })?.code;
    if (code === '23P01')
      throw new ConflictException('A panelist has an overlapping interview.');
    if (code === '23503')
      throw new ConflictException(
        'A panelist with a submitted scorecard cannot be removed.',
      );
    throw error;
  }

  private async panelIds(db: DbClient, actor: Actor, interviewId: string) {
    const panel = await db.query<{ user_id: string }>(
      'SELECT user_id FROM interview_panelists WHERE tenant_id=$1 AND interview_id=$2 ORDER BY user_id',
      [actor.tenantId, interviewId],
    );
    return panel.map((row) => row.user_id);
  }

  private async withPanel(
    db: DbClient,
    actor: Actor,
    interview: InterviewAccessRecord,
  ) {
    return {
      ...interview,
      panelist_ids: await this.panelIds(db, actor, interview.id),
    };
  }

  async create(actor: Actor, input: CreateInterviewInput) {
    this.policy.assertInterviewManager(actor);
    this.validateSchedule(input.startsAt, input.endsAt);
    this.validateVenue(
      input.mode,
      input.location ?? null,
      input.meetingUrl ?? null,
      input.sendInvitations,
    );
    if (input.sendInvitations)
      await this.calendar.assertConnected(
        actor.tenantId,
        input.calendarProvider,
      );
    let id: string;
    try {
      id = await this.db.transaction(async (tx) => {
        await this.lockTenant(tx, actor);
        const application = await this.eligibleApplication(
          tx,
          actor,
          input.applicationId,
        );
        const job = await tx.one<{ screening_criteria: ScreeningCriterion[] }>(
          'SELECT screening_criteria FROM jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE',
          [actor.tenantId, application.job_id],
        );
        if (!job) throw new NotFoundException('Job not found.');
        await this.policy.assertInterviewPanelists(
          tx,
          actor,
          input.panelistIds,
        );
        const interview = await tx.one<InterviewAccessRecord>(
          `INSERT INTO interviews (tenant_id,application_id,round,mode,starts_at,ends_at,location,meeting_url,criteria_snapshot,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            actor.tenantId,
            input.applicationId,
            input.round,
            input.mode,
            input.startsAt,
            input.endsAt,
            input.location ?? null,
            input.meetingUrl ?? null,
            JSON.stringify(job.screening_criteria),
            actor.userId,
          ],
        );
        await tx.query(
          `INSERT INTO interview_panelists (tenant_id,interview_id,user_id,starts_at,ends_at,status)
           SELECT $1,$2,panelist,$4,$5,$6 FROM unnest($3::uuid[]) panelist`,
          [
            actor.tenantId,
            interview!.id,
            input.panelistIds,
            interview!.starts_at,
            interview!.ends_at,
            interview!.status,
          ],
        );
        await audit(
          tx,
          actor,
          'interview.created',
          'interview',
          interview!.id,
          { applicationId: input.applicationId },
        );
        return interview!.id;
      });
    } catch (error) {
      this.schedulingError(error);
    }
    const calendar: CalendarSync = input.sendInvitations
      ? await this.calendar.sync(actor.tenantId, id, input.calendarProvider)
      : { status: 'not_sent' };
    return { ...(await this.details(this.db, actor, id)), calendar };
  }

  async list(actor: Actor, input: InterviewListInput) {
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const filters = ['i.tenant_id=$1'];
      const filter = (sql: (n: number) => string, value: unknown) => {
        params.push(value);
        filters.push(sql(params.length));
      };
      if (input.applicationId)
        filter((n) => `i.application_id=$${n}`, input.applicationId);
      if (input.jobId) filter((n) => `a.job_id=$${n}`, input.jobId);
      if (input.status) filter((n) => `i.status=$${n}`, input.status);
      if (input.from) filter((n) => `i.ends_at>$${n}`, input.from);
      if (input.to) filter((n) => `i.starts_at<$${n}`, input.to);
      if (input.when === 'upcoming')
        filters.push(`i.status='SCHEDULED' AND i.ends_at>now()`);
      if (input.when === 'past')
        filters.push(`i.status='SCHEDULED' AND i.ends_at<=now()`);
      if (isScoped(actor)) params.push(actor.userId);
      const where =
        filters.join(' AND ') +
        this.policy.interviewPredicate(actor, 'i.id', params.length);
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM interviews i
         JOIN applications a ON a.tenant_id=i.tenant_id AND a.id=i.application_id
         WHERE ${where}`,
        params,
      );
      const me = params.length + 1;
      const data = await tx.query<InterviewDetails>(
        `${details(me)} WHERE ${where}
         ORDER BY i.starts_at ${input.when === 'past' ? 'DESC' : 'ASC'},i.id
         LIMIT $${me + 1} OFFSET $${me + 2}`,
        [...params, actor.userId, input.limit, input.offset],
      );
      return {
        data: data.map((row) => this.visible(actor, row)),
        pagination: { limit: input.limit, offset: input.offset },
        total: Number(count!.total),
      };
    });
  }

  async get(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertInterview(tx, actor, id);
      return this.details(tx, actor, id);
    });
  }

  /**
   * Adds a scheduled interview to a connected calendar (inviting the panel
   * and the candidate), sends its event again after a problem, or moves it
   * to the other calendar.
   */
  async addToCalendar(actor: Actor, id: string, provider?: CalendarProvider) {
    this.policy.assertInterviewManager(actor);
    const interview = await this.db.transaction((tx) =>
      this.policy.assertInterview(tx, actor, id),
    );
    if (interview.status === InterviewStatus.CANCELLED)
      throw new ConflictException(
        'Cancelled interviews can’t be added to the calendar.',
      );
    if (new Date(interview.ends_at).getTime() <= Date.now())
      throw new ConflictException('This interview has already taken place.');
    await this.calendar.assertConnected(actor.tenantId, provider);
    const calendar = await this.calendar.sync(actor.tenantId, id, provider);
    return { ...(await this.details(this.db, actor, id)), calendar };
  }

  async reschedule(actor: Actor, id: string, input: RescheduleInterviewInput) {
    this.policy.assertInterviewManager(actor);
    if (input.startsAt && input.endsAt)
      this.validateSchedule(input.startsAt, input.endsAt);
    if (input.sendInvitations || input.calendarProvider)
      await this.calendar.assertConnected(
        actor.tenantId,
        input.calendarProvider,
      );
    let onCalendar = false;
    try {
      await this.db.transaction(async (tx) => {
        await this.lockTenant(tx, actor);
        const previous = (await this.policy.assertInterview(tx, actor, id, {
          lock: true,
        })) as InterviewAccessRecord & { calendar_event_id: string | null };
        // Already in the calendar, or to be added (or moved) now.
        onCalendar =
          !!previous.calendar_event_id ||
          !!input.sendInvitations ||
          !!input.calendarProvider;
        if (previous.status === InterviewStatus.CANCELLED)
          throw new ConflictException(
            'Cancelled interviews cannot be rescheduled.',
          );
        await this.eligibleApplication(tx, actor, previous.application_id);
        const mode = input.mode ?? previous.mode;
        const location =
          input.location === undefined ? previous.location : input.location;
        const meetingUrl =
          input.meetingUrl === undefined
            ? previous.meeting_url
            : input.meetingUrl;
        // In the calendar: its event gets a link if it has none.
        this.validateVenue(mode, location, meetingUrl, onCalendar);
        const existingPanel = await this.panelIds(tx, actor, id);
        const panelistIds = input.panelistIds ?? existingPanel;
        await this.policy.assertInterviewPanelists(tx, actor, panelistIds);
        const removed = existingPanel.filter(
          (userId) => !panelistIds.includes(userId),
        );
        if (removed.length)
          await tx.query(
            'DELETE FROM interview_panelists WHERE tenant_id=$1 AND interview_id=$2 AND user_id=ANY($3::uuid[])',
            [actor.tenantId, id, removed],
          );
        // Reservation times/status follow this update via the composite ON UPDATE CASCADE FK.
        const interview = await tx.one<InterviewAccessRecord>(
          `UPDATE interviews SET mode=$3,starts_at=$4,ends_at=$5,location=$6,meeting_url=$7,round=$8,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [
            actor.tenantId,
            id,
            mode,
            input.startsAt ?? previous.starts_at,
            input.endsAt ?? previous.ends_at,
            location,
            meetingUrl,
            input.round ?? previous.round,
          ],
        );
        const added = panelistIds.filter(
          (userId) => !existingPanel.includes(userId),
        );
        if (added.length)
          await tx.query(
            `INSERT INTO interview_panelists (tenant_id,interview_id,user_id,starts_at,ends_at,status)
             SELECT $1,$2,panelist,$4,$5,$6 FROM unnest($3::uuid[]) panelist`,
            [
              actor.tenantId,
              id,
              added,
              interview!.starts_at,
              interview!.ends_at,
              interview!.status,
            ],
          );
        await audit(tx, actor, 'interview.rescheduled', 'interview', id);
      });
    } catch (error) {
      this.schedulingError(error);
    }
    // The calendar event follows, and tells everyone invited.
    const calendar: CalendarSync = onCalendar
      ? await this.calendar.sync(actor.tenantId, id, input.calendarProvider)
      : { status: 'not_sent' };
    return { ...(await this.details(this.db, actor, id)), calendar };
  }

  async cancel(actor: Actor, id: string, reason: string) {
    this.policy.assertInterviewManager(actor);
    let newly = false;
    const cancelled = await this.db.transaction(async (tx) => {
      await this.lockTenant(tx, actor);
      const previous = await this.policy.assertInterview(tx, actor, id, {
        lock: true,
      });
      if (previous.status === InterviewStatus.CANCELLED)
        return this.withPanel(tx, actor, previous);
      newly = true;
      const interview = await tx.one<InterviewAccessRecord>(
        `UPDATE interviews SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, InterviewStatus.CANCELLED],
      );
      await audit(tx, actor, 'interview.cancelled', 'interview', id, {
        reason,
      });
      return this.withPanel(tx, actor, interview!);
    });
    // In the calendar: the event goes, and everyone invited is told.
    if (newly) await this.calendar.remove(actor.tenantId, id);
    return cancelled;
  }
}
