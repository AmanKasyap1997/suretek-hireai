import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import { ApplicationStage, JobStatus } from '../../../shared/enums';
import {
  ApplicationInput,
  StageInput,
  Pagination,
} from './applications.schemas';
import type { Job } from '../jobs';
import type { Candidate } from '../candidates';

export interface Application {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: ApplicationStage;
}

@Injectable()
export class ApplicationsService {
  constructor(private readonly db: DbService) {}

  async createApplication(actor: Actor, input: ApplicationInput) {
    return this.db.transaction(async (tx) => {
      const job = await tx.one<Job>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE',
        [actor.tenantId, input.jobId],
      );
      if (!job) throw new NotFoundException('Job not found.');
      if (job.status !== JobStatus.PUBLISHED)
        throw new ConflictException('Applications require a published job.');
      const candidate = await tx.one<Candidate>(
        'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, input.candidateId],
      );
      if (!candidate) throw new NotFoundException('Candidate not found.');
      const application = await tx.one<Application>(
        `INSERT INTO applications (tenant_id,job_id,candidate_id) VALUES ($1,$2,$3) RETURNING *`,
        [actor.tenantId, input.jobId, input.candidateId],
      );
      await audit(
        tx,
        actor,
        'application.created',
        'application',
        application!.id,
      );
      return application;
    });
  }

  async listApplications(actor: Actor, page: Pagination) {
    const data = await this.db.query<Application>(
      `SELECT a.*,j.title AS job_title,c.full_name AS candidate_name
       FROM applications a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
       WHERE a.tenant_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getApplication(actor: Actor, id: string) {
    const row = await this.db.one<Application>(
      'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Application not found.');
    return row;
  }

  async changeStage(actor: Actor, id: string, input: StageInput) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Application not found.');
      const allowed: Record<ApplicationStage, ApplicationStage[]> = {
        [ApplicationStage.APPLIED]: [
          ApplicationStage.SHORTLISTED,
          ApplicationStage.REJECTED,
        ],
        [ApplicationStage.SHORTLISTED]: [
          ApplicationStage.INTERVIEW,
          ApplicationStage.REJECTED,
        ],
        [ApplicationStage.INTERVIEW]: [ApplicationStage.REJECTED],
        [ApplicationStage.OFFER]: [],
        [ApplicationStage.HIRED]: [],
        [ApplicationStage.REJECTED]: [],
      };
      if (!allowed[row.stage].includes(input.stage))
        throw new ConflictException(
          `Cannot change application from ${row.stage} to ${input.stage}.`,
        );
      const application = await tx.one<Application>(
        'UPDATE applications SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, input.stage],
      );
      await audit(tx, actor, 'application.stage_changed', 'application', id, {
        from: row.stage,
        to: input.stage,
      });
      return application;
    });
  }
}
