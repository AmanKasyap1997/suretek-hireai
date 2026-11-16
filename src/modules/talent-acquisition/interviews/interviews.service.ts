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
  InterviewAccessRecord,
  ScreeningCriterion,
  isScoped,
} from '../../../shared/ta-policy';
import {
  CreateInterviewInput,
  InterviewListInput,
  RescheduleInterviewInput,
} from './interviews.schemas';

@Injectable()
export class InterviewsService {
  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
  ) {}

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
  ) {
    if (mode === InterviewMode.VIDEO && !meetingUrl)
      throw new BadRequestException('Video interviews require a meeting URL.');
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
    );
    try {
      return await this.db.transaction(async (tx) => {
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
        return this.withPanel(tx, actor, interview!);
      });
    } catch (error) {
      this.schedulingError(error);
    }
  }

  async list(actor: Actor, input: InterviewListInput) {
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const filters = ['i.tenant_id=$1'];
      if (input.applicationId) {
        params.push(input.applicationId);
        filters.push(`i.application_id=$${params.length}`);
      }
      if (input.status) {
        params.push(input.status);
        filters.push(`i.status=$${params.length}`);
      }
      if (isScoped(actor)) params.push(actor.userId);
      const where =
        filters.join(' AND ') +
        this.policy.interviewPredicate(actor, 'i.id', params.length);
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM interviews i WHERE ${where}`,
        params,
      );
      const data = await tx.query<
        InterviewAccessRecord & { panelist_ids: string[] }
      >(
        `SELECT i.*,ARRAY(SELECT panel.user_id FROM interview_panelists panel
          WHERE panel.tenant_id=$1 AND panel.interview_id=i.id ORDER BY panel.user_id) AS panelist_ids
         FROM interviews i WHERE ${where} ORDER BY i.starts_at,i.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, input.limit, input.offset],
      );
      return {
        data,
        pagination: { limit: input.limit, offset: input.offset },
        total: Number(count!.total),
      };
    });
  }

  async get(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const interview = await this.policy.assertInterview(tx, actor, id);
      return this.withPanel(tx, actor, interview);
    });
  }

  async reschedule(actor: Actor, id: string, input: RescheduleInterviewInput) {
    this.policy.assertInterviewManager(actor);
    if (input.startsAt && input.endsAt)
      this.validateSchedule(input.startsAt, input.endsAt);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockTenant(tx, actor);
        const previous = await this.policy.assertInterview(tx, actor, id, {
          lock: true,
        });
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
        this.validateVenue(mode, location, meetingUrl);
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
          `UPDATE interviews SET mode=$3,starts_at=$4,ends_at=$5,location=$6,meeting_url=$7,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [
            actor.tenantId,
            id,
            mode,
            input.startsAt ?? previous.starts_at,
            input.endsAt ?? previous.ends_at,
            location,
            meetingUrl,
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
        return this.withPanel(tx, actor, interview!);
      });
    } catch (error) {
      this.schedulingError(error);
    }
  }

  async cancel(actor: Actor, id: string, reason: string) {
    this.policy.assertInterviewManager(actor);
    return this.db.transaction(async (tx) => {
      await this.lockTenant(tx, actor);
      const previous = await this.policy.assertInterview(tx, actor, id, {
        lock: true,
      });
      if (previous.status === InterviewStatus.CANCELLED)
        return this.withPanel(tx, actor, previous);
      const interview = await tx.one<InterviewAccessRecord>(
        `UPDATE interviews SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, InterviewStatus.CANCELLED],
      );
      await audit(tx, actor, 'interview.cancelled', 'interview', id, {
        reason,
      });
      return this.withPanel(tx, actor, interview!);
    });
  }
}
