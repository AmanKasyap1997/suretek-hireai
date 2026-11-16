import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { AccessPolicy, isScoped } from '../../../shared/ta-policy';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import { JobStatus } from '../../../shared/enums';
import { JobInput, JobUpdate, Pagination } from './jobs.schemas';

export interface Job {
  id: string;
  status: JobStatus;
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
      const from = 'jobs j';
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM ${from} WHERE ${where}`,
        params,
      );
      const direction = page.direction === 'asc' ? 'ASC' : 'DESC';
      const sort = page.sort === 'updated_at' ? 'updated_at' : 'created_at';
      const data = await tx.query<Job>(
        `SELECT j.* FROM ${from} WHERE ${where} ORDER BY j.${sort} ${direction},j.id ${direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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

  async updateJob(actor: Actor, id: string, input: JobUpdate) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Job>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      if (row.status !== JobStatus.DRAFT)
        throw new ConflictException('Only draft jobs can be edited.');
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
      await audit(tx, actor, 'job.updated', 'job', id);
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
        "UPDATE jobs SET status=$3,closed_at=CASE WHEN $3='CLOSED' THEN now() ELSE closed_at END,close_reason=COALESCE($4,close_reason),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        [actor.tenantId, id, target, closeReason],
      );
      await audit(tx, actor, `job.${target.toLowerCase()}`, 'job', id);
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
    const fields: Record<string, string> = {
      openings: 'openings',
      employmentType: 'employment_type',
      salaryMin: 'salary_min',
      salaryMax: 'salary_max',
      hiringManagerUserId: 'hiring_manager_user_id',
      screeningCriteria: 'screening_criteria',
      closeReason: 'close_reason',
    };
    const params: unknown[] = [actor.tenantId, id];
    const sets: string[] = [];
    for (const [key, col] of Object.entries(fields))
      if (key in input) {
        const value = input[key as keyof JobUpdate];
        params.push(
          key === 'screeningCriteria' ? JSON.stringify(value) : value,
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
      const row = await tx.one(
        'INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,$4) RETURNING *',
        [actor.tenantId, id, input.userId, input.role],
      );
      await audit(tx, actor, 'job.assignment_created', 'job', id);
      return row;
    });
  }
  async assignments(actor: Actor, id: string) {
    await this.policy.assertJob(this.db, actor, id);
    return this.db.query(
      'SELECT * FROM job_assignments WHERE tenant_id=$1 AND job_id=$2',
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
