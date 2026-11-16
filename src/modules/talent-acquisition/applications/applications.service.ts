import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { AccessPolicy, isScoped } from '../../../shared/ta-policy';
import { stageEvent } from '../../../shared/ta-history';
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
  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
  ) {}

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
        'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 AND erased_at IS NULL FOR SHARE',
        [actor.tenantId, input.candidateId],
      );
      if (!candidate) throw new NotFoundException('Candidate not found.');
      const application = await tx.one<Application>(
        `INSERT INTO applications (tenant_id,job_id,candidate_id) VALUES ($1,$2,$3) RETURNING *`,
        [actor.tenantId, input.jobId, input.candidateId],
      );
      await stageEvent(
        tx,
        actor,
        application!.id,
        null,
        ApplicationStage.APPLIED,
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
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const filters = ['a.tenant_id=$1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        filters.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (page.createdFrom) add('a.created_at>=?', page.createdFrom);
      if (page.createdTo) add('a.created_at<=?', page.createdTo);
      if (page.jobId) add('a.job_id=?', page.jobId);
      if (page.stage) add('a.stage=?', page.stage);
      if (page.status) add('j.status=?', page.status);
      if (page.q)
        add('(c.full_name ILIKE ? OR c.email ILIKE ?)', `%${page.q}%`);
      if (isScoped(actor)) {
        params.push(actor.userId);
        filters.push(
          this.policy
            .predicate(actor, 'a.job_id', params.length)
            .replace(/^ AND /, ''),
        );
      }
      const where = filters.join(' AND ');
      const from =
        'applications a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id';
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM ${from} WHERE ${where}`,
        params,
      );
      const direction = page.direction === 'asc' ? 'ASC' : 'DESC';
      const sort = page.sort === 'updated_at' ? 'updated_at' : 'created_at';
      const data = await tx.query<Application>(
        `SELECT a.*,j.title AS job_title,c.full_name AS candidate_name FROM ${from} WHERE ${where} ORDER BY a.${sort} ${direction},a.id ${direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      return {
        data,
        pagination: { limit: page.limit, offset: page.offset },
        total: Number(count!.total),
      };
    });
  }

  async getApplication(actor: Actor, id: string) {
    const row = await this.db.one<Application>(
      'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Application not found.');
    await this.policy.assertJob(this.db, actor, row.job_id);
    return row;
  }

  async changeStage(actor: Actor, id: string, input: StageInput) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Application not found.');
      await this.policy.assertJob(tx, actor, row.job_id);
      this.policy.assertStage(actor, input.stage);
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
      await stageEvent(
        tx,
        actor,
        id,
        row.stage,
        input.stage,
        input.reasonCode,
        input.note,
      );
      await audit(tx, actor, 'application.stage_changed', 'application', id, {
        from: row.stage,
        to: input.stage,
      });
      return application;
    });
  }
  async history(actor: Actor, id: string) {
    await this.getApplication(actor, id);
    return this.db.query(
      'SELECT * FROM application_stage_events WHERE tenant_id=$1 AND application_id=$2 ORDER BY created_at,id',
      [actor.tenantId, id],
    );
  }
}
