import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { AccessPolicy, isScoped } from '../../../shared/ta-policy';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import { JobStatus, Role } from '../../../shared/enums';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { JobInput, JobUpdate, Pagination } from './jobs.schemas';
import { InterviewSetup } from './interview-setup';

export interface Job {
  id: string;
  status: JobStatus;
}

const NOT_APPROVED =
  'A recruiter works on this job once an HR Admin approves it.';

/** Each job field's column. */
const columns: Record<keyof JobUpdate, string> = {
  title: 'title',
  description: 'description',
  department: 'department',
  location: 'location',
  employmentType: 'employment_type',
  openings: 'openings',
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
  hiringManagerUserId: 'hiring_manager_user_id',
  screeningCriteria: 'screening_criteria',
  closeReason: 'close_reason',
  autoScreen: 'auto_screen',
  callQuestions: 'call_questions',
  interviewSetup: 'interview_setup',
};

/**
 * What candidates see on the careers page and job posts. Once an HR Admin
 * has approved a job, only an HR Admin changes these.
 */
const publicFields: (keyof JobUpdate)[] = [
  'title',
  'description',
  'department',
  'location',
  'employmentType',
  'openings',
  'salaryMin',
  'salaryMax',
];

/** Numeric columns (PostgreSQL returns numeric as text). */
const numericFields: (keyof JobUpdate)[] = [
  'openings',
  'salaryMin',
  'salaryMax',
];

/** A value as stored, for comparing: numbers as numbers, JSON key-sorted. */
function normalized(key: keyof JobUpdate, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (numericFields.includes(key)) return Number(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(sorted));
  if (typeof value === 'object') return JSON.stringify(sorted(value));
  return value;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}

/** The fields an update actually changes. */
function changedFields(row: Record<string, unknown>, input: JobUpdate) {
  return (Object.keys(input) as (keyof JobUpdate)[]).filter(
    (key) =>
      key in columns &&
      normalized(key, input[key]) !== normalized(key, row[columns[key]]),
  );
}

@Injectable()
export class JobsService {
  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
  ) {}

  async createJob(actor: Actor, input: JobInput) {
    return this.db.transaction(async (tx) => {
      const job = await tx.one<Job>(
        `INSERT INTO jobs (tenant_id,title,description,department,location,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          actor.tenantId,
          input.title,
          input.description,
          input.department,
          input.location,
          actor.userId,
        ],
      );
      await this.requirements(tx, actor, job!.id, input);
      // A hiring manager's request: they're on its hiring team, so they see
      // it, and its applicants once it's published.
      if (actor.role === Role.HIRING_MANAGER)
        await tx.query(
          "INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,'HIRING_MANAGER')",
          [actor.tenantId, job!.id, actor.userId],
        );
      Object.assign(
        job!,
        await tx.one('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [
          actor.tenantId,
          job!.id,
        ]),
      );
      await audit(tx, actor, 'job.created', 'job', job!.id);
      return job;
    });
  }

  async listJobs(actor: Actor, page: Pagination) {
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const filters = ['j.tenant_id=$1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        filters.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (page.createdFrom) add('j.created_at>=?', page.createdFrom);
      if (page.createdTo) add('j.created_at<=?', page.createdTo);
      if (page.status) add('j.status=?', page.status);
      // Requests an HR Admin hasn't approved or sent back yet.
      if (page.awaiting === 'approval')
        filters.push("j.status='DRAFT' AND j.requested_at IS NOT NULL");
      if (page.jobId) add('j.id=?', page.jobId);
      if (page.stage)
        add(
          'EXISTS(SELECT 1 FROM applications a WHERE a.tenant_id=j.tenant_id AND a.job_id=j.id AND a.stage=?)',
          page.stage,
        );
      if (page.q)
        add('(j.title ILIKE ? OR j.description ILIKE ?)', `%${page.q}%`);
      if (isScoped(actor)) {
        params.push(actor.userId);
        filters.push(
          this.policy
            .predicate(actor, 'j.id', params.length)
            .replace(/^ AND /, ''),
        );
      }
      const where = filters.join(' AND ');
      const from =
        'jobs j LEFT JOIN users creator ON creator.tenant_id=j.tenant_id AND creator.id=j.created_by';
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM ${from} WHERE ${where}`,
        params,
      );
      const direction = page.direction === 'asc' ? 'ASC' : 'DESC';
      const sort = page.sort === 'updated_at' ? 'updated_at' : 'created_at';
      const data = await tx.query<Job>(
        `SELECT j.*,creator.full_name AS created_by_name FROM ${from} WHERE ${where} ORDER BY j.${sort} ${direction},j.id ${direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      return {
        data,
        pagination: { limit: page.limit, offset: page.offset },
        total: Number(count!.total),
      };
    });
  }

  async getJob(actor: Actor, id: string) {
    await this.policy.assertJob(this.db, actor, id);
    const row = await this.db.one<Job>(
      'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Job not found.');
    return row;
  }

  /**
   * Edits a job, also once approved or published (until it closes), e.g. to
   * add call questions. Published changes show on the careers page at once;
   * screenings and calls already made keep what they used.
   */
  async updateJob(actor: Actor, id: string, input: JobUpdate) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Job & Record<string, unknown>>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      if (row.status === JobStatus.CLOSED)
        throw new ConflictException('Closed jobs can’t be edited.');
      // Recruiters work on a job once an HR Admin has approved it.
      if (actor.role === Role.RECRUITER && row.status === JobStatus.DRAFT)
        throw new ConflictException(NOT_APPROVED);
      // A hiring manager edits their own requests, until approved.
      if (actor.role === Role.HIRING_MANAGER) {
        await this.policy.assertJob(tx, actor, id);
        if (row.status !== JobStatus.DRAFT)
          throw new ConflictException(
            'This job is approved: a recruiter or HR Admin changes it now.',
          );
      }
      const changed = changedFields(row, input);
      if (
        row.status !== JobStatus.DRAFT &&
        !ADMIN_ROLES.includes(actor.role) &&
        changed.some((key) => publicFields.includes(key))
      )
        throw new ForbiddenException(
          'Only an HR Admin can change what candidates see on an approved or published job. You can still change its screening criteria and call questions.',
        );
      const job = await tx.one<Job>(
        `UPDATE jobs SET title=COALESCE($3,title),description=COALESCE($4,description),
         department=COALESCE($5,department),location=COALESCE($6,location),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [
          actor.tenantId,
          id,
          input.title,
          input.description,
          input.department,
          input.location,
        ],
      );
      await this.requirements(tx, actor, id, input);
      Object.assign(
        job!,
        await tx.one('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [
          actor.tenantId,
          id,
        ]),
      );
      await audit(tx, actor, 'job.updated', 'job', id, {
        status: row.status,
        fields: changed,
      });
      return job;
    });
  }

  /** Sets how the AI books this job's interviews (any status but closed). */
  async setInterviewSetup(
    actor: Actor,
    id: string,
    setup: InterviewSetup | null,
  ) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertJob(tx, actor, id);
      const row = await tx.one<Job>(
        'SELECT status FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      if (row.status === JobStatus.CLOSED)
        throw new ConflictException('This job is closed.');
      if (actor.role === Role.RECRUITER && row.status === JobStatus.DRAFT)
        throw new ConflictException(NOT_APPROVED);
      if (setup)
        await this.policy.assertInterviewPanelists(
          tx,
          actor,
          setup.panelistIds,
        );
      const job = await tx.one<Job>(
        'UPDATE jobs SET interview_setup=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, setup ? JSON.stringify(setup) : null],
      );
      await audit(tx, actor, 'job.interview_setup_updated', 'job', id, {
        on: !!setup,
        ...(setup
          ? {
              mode: setup.mode,
              minutes: setup.minutes,
              panel: setup.panelistIds.length,
            }
          : {}),
      });
      return job;
    });
  }

  async transitionJob(
    actor: Actor,
    id: string,
    target: JobStatus,
    closeReason?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Job>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      const allowed: Record<JobStatus, JobStatus[]> = {
        [JobStatus.DRAFT]: [JobStatus.APPROVED, JobStatus.CLOSED],
        [JobStatus.APPROVED]: [JobStatus.PUBLISHED, JobStatus.CLOSED],
        [JobStatus.PUBLISHED]: [JobStatus.CLOSED],
        [JobStatus.CLOSED]: [],
      };
      if (!allowed[row.status].includes(target))
        throw new ConflictException(
          `Cannot change job from ${row.status} to ${target}.`,
        );
      const job = await tx.one<Job>(
        "UPDATE jobs SET status=$3,closed_at=CASE WHEN $3='CLOSED' THEN now() ELSE closed_at END,close_reason=COALESCE($4,close_reason),review_note=CASE WHEN $3='APPROVED' THEN NULL ELSE review_note END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        [actor.tenantId, id, target, closeReason],
      );
      await audit(tx, actor, `job.${target.toLowerCase()}`, 'job', id);
      return job;
    });
  }
  /**
   * Submits a draft for an HR Admin's approval (a hiring manager's request,
   * or a recruiter's job). It can still be edited while it waits.
   */
  async submitJob(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertJob(tx, actor, id);
      const row = await tx.one<Job>(
        'SELECT status FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      if (row.status !== JobStatus.DRAFT)
        throw new ConflictException(
          'Only a draft can be submitted for approval.',
        );
      const job = await tx.one<Job>(
        'UPDATE jobs SET requested_at=now(),review_note=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id],
      );
      await audit(tx, actor, 'job.submitted', 'job', id);
      return job;
    });
  }

  /** An HR Admin sends a request back to be changed, saying why. */
  async sendBack(actor: Actor, id: string, note: string) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Job & { requested_at: Date | null }>(
        'SELECT status,requested_at FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      if (row.status !== JobStatus.DRAFT || !row.requested_at)
        throw new ConflictException(
          'Only a job awaiting approval can be sent back.',
        );
      const job = await tx.one<Job>(
        'UPDATE jobs SET requested_at=NULL,review_note=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, note],
      );
      await audit(tx, actor, 'job.sent_back', 'job', id);
      return job;
    });
  }

  private async requirements(
    tx: import('../../../platform/database/db.service').DbClient,
    actor: Actor,
    id: string,
    input: JobUpdate,
  ) {
    if (input.hiringManagerUserId) {
      const manager = await tx.one(
        "SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND role='HIRING_MANAGER' AND active=true",
        [actor.tenantId, input.hiringManagerUserId],
      );
      if (!manager) throw new NotFoundException('Hiring manager not found.');
    }
    // The panel the AI books interviews with: people who may interview.
    if (input.interviewSetup)
      await this.policy.assertInterviewPanelists(
        tx,
        actor,
        input.interviewSetup.panelistIds,
      );
    const fields: Record<string, string> = {
      openings: 'openings',
      employmentType: 'employment_type',
      salaryMin: 'salary_min',
      salaryMax: 'salary_max',
      hiringManagerUserId: 'hiring_manager_user_id',
      screeningCriteria: 'screening_criteria',
      closeReason: 'close_reason',
      autoScreen: 'auto_screen',
      callQuestions: 'call_questions',
      interviewSetup: 'interview_setup',
    };
    const params: unknown[] = [actor.tenantId, id];
    const sets: string[] = [];
    for (const [key, col] of Object.entries(fields))
      if (key in input) {
        const value = input[key as keyof JobUpdate];
        params.push(
          key === 'screeningCriteria' ||
            key === 'callQuestions' ||
            (key === 'interviewSetup' && value !== null)
            ? JSON.stringify(value)
            : value,
        );
        sets.push(`${col}=$${params.length}`);
      }
    if (sets.length)
      await tx.query(
        `UPDATE jobs SET ${sets.join(',')} WHERE tenant_id=$1 AND id=$2`,
        params,
      );
  }
  async assign(
    actor: Actor,
    id: string,
    input: { userId: string; role: string },
  ) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertJob(tx, actor, id);
      const user = await tx.one(
        'SELECT id,role FROM users WHERE tenant_id=$1 AND id=$2 AND active=true',
        [actor.tenantId, input.userId],
      );
      if (
        !user ||
        user.role !==
          (input.role === 'RECRUITER_OWNER' ? 'RECRUITER' : input.role)
      )
        throw new NotFoundException('Eligible user not found.');
      const row = await tx
        .one(
          'INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,$4) RETURNING *',
          [actor.tenantId, id, input.userId, input.role],
        )
        .catch((error: { code?: string }) => {
          if (error?.code === '23505')
            throw new ConflictException(
              'They’re already on this job’s hiring team.',
            );
          throw error;
        });
      await audit(tx, actor, 'job.assignment_created', 'job', id);
      return row;
    });
  }

  /** The job's hiring team: who is assigned, as what, with their names. */
  async assignments(actor: Actor, id: string) {
    await this.policy.assertJob(this.db, actor, id);
    return this.db.query(
      `SELECT ja.*,u.full_name,u.email,u.active FROM job_assignments ja
       JOIN users u ON u.tenant_id=ja.tenant_id AND u.id=ja.user_id
       WHERE ja.tenant_id=$1 AND ja.job_id=$2 ORDER BY ja.role,u.full_name,ja.id`,
      [actor.tenantId, id],
    );
  }

  async unassign(actor: Actor, id: string, assignmentId: string) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertJob(tx, actor, id);
      const row = await tx.one(
        'DELETE FROM job_assignments WHERE tenant_id=$1 AND job_id=$2 AND id=$3 RETURNING id',
        [actor.tenantId, id, assignmentId],
      );
      if (!row) throw new NotFoundException('Assignment not found.');
      await audit(tx, actor, 'job.assignment_removed', 'job', id);
      return row;
    });
  }
}
