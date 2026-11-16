import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
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
  constructor(private readonly db: DbService) {}

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
      await audit(tx, actor, 'job.created', 'job', job!.id);
      return job;
    });
  }

  async listJobs(actor: Actor, page: Pagination) {
    const data = await this.db.query<Job>(
      `SELECT * FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getJob(actor: Actor, id: string) {
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
      await audit(tx, actor, 'job.updated', 'job', id);
      return job;
    });
  }

  async transitionJob(actor: Actor, id: string, target: JobStatus) {
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
        'UPDATE jobs SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, target],
      );
      await audit(tx, actor, `job.${target.toLowerCase()}`, 'job', id);
      return job;
    });
  }
}
