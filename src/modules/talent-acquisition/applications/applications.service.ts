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
import { ApplicationStage, JobStatus, Role } from '../../../shared/enums';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import {
  ApplicationInput,
  StageInput,
  Pagination,
} from './applications.schemas';
import type { Job } from '../jobs';
import type { Candidate } from '../candidates';
import { latestScreeningJoin } from '../screening';
import { applicationResumeOrder } from '../../../shared/ta-resume';

export interface Application {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: ApplicationStage;
}

/** Roles that see an applicant's pay and contact details. */
const PAY_AND_CONTACT_ROLES: readonly Role[] = [
  ...RECRUITMENT_ROLES,
  Role.HIRING_MANAGER,
];
const money = (value: string | null) => (value === null ? null : Number(value));

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
      if (page.screening)
        filters.push(
          {
            screened: "s.status='COMPLETED'",
            not_screened: 's.id IS NULL',
            in_progress: "s.status IN ('QUEUED','RUNNING')",
            failed: "s.status='FAILED'",
          }[page.screening],
        );
      if (isScoped(actor)) {
        params.push(actor.userId);
        filters.push(
          this.policy
            .predicate(actor, 'a.job_id', params.length)
            .replace(/^ AND /, ''),
        );
      }
      const where = filters.join(' AND ');
      const from = `applications a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id LEFT JOIN application_details d ON d.tenant_id=a.tenant_id AND d.application_id=a.id ${latestScreeningJoin}`;
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM ${from} WHERE ${where}`,
        params,
      );
      const direction = page.direction === 'asc' ? 'ASC' : 'DESC';
      // Best match first: unscreened applications last, then newest.
      const order =
        page.sort === 'score'
          ? `s.score ${direction} NULLS LAST,a.created_at DESC,a.id DESC`
          : `a.${page.sort === 'updated_at' ? 'updated_at' : 'created_at'} ${direction},a.id ${direction}`;
      const data = await tx.query<Application>(
        `SELECT a.*,j.title AS job_title,c.full_name AS candidate_name,d.current_location,d.total_experience_months,d.notice_period,d.source,
           s.status AS screening_status,s.score AS screening_score,s.fit AS screening_fit,s.missing_must_have AS screening_missing_must_have
         FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      // Screenings quote the resume, which interviewers don't see.
      if (actor.role === Role.INTERVIEWER)
        for (const row of data)
          Object.assign(row, {
            screening_status: null,
            screening_score: null,
            screening_fit: null,
            screening_missing_must_have: null,
          });
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

  /** What the candidate submitted with this application, for the review panel. */
  async details(actor: Actor, id: string) {
    await this.getApplication(actor, id);
    const open = PAY_AND_CONTACT_ROLES.includes(actor.role);
    return this.db.transaction(async (tx) => {
      const row = await tx.one<{
        id: string;
        stage: ApplicationStage;
        created_at: Date;
        job_id: string;
        job_title: string;
        candidate_id: string;
        full_name: string;
        email: string;
        candidate_phone: string | null;
        erased_at: Date | null;
        has_details: boolean;
        phone: string | null;
        current_location: string | null;
        willing_to_relocate: boolean | null;
        total_experience_months: number | null;
        current_company: string | null;
        current_title: string | null;
        notice_period: string | null;
        last_working_day: string | null;
        current_ctc: string | null;
        expected_ctc: string | null;
        ctc_currency: string | null;
        linkedin_url: string | null;
        portfolio_url: string | null;
        cover_letter: string | null;
        source: string | null;
        referrer: string | null;
      }>(
        `SELECT a.id,a.stage,a.created_at,a.job_id,j.title AS job_title,c.id AS candidate_id,c.full_name,c.email,c.phone AS candidate_phone,c.erased_at,
          d.application_id IS NOT NULL AS has_details,d.phone,d.current_location,d.willing_to_relocate,d.total_experience_months,d.current_company,d.current_title,
          d.notice_period,to_char(d.last_working_day,'YYYY-MM-DD') AS last_working_day,d.current_ctc,d.expected_ctc,d.ctc_currency,d.linkedin_url,d.portfolio_url,
          d.cover_letter,d.source,d.referrer
         FROM applications a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
         LEFT JOIN application_details d ON d.tenant_id=a.tenant_id AND d.application_id=a.id
         WHERE a.tenant_id=$1 AND a.id=$2`,
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Application not found.');
      // One resume: the one sent with this application (see the ordering).
      const resumes = RECRUITMENT_ROLES.includes(actor.role)
        ? await tx.query<{ application_id: string | null }>(
            `SELECT d.id,d.original_name,d.content_type,d.byte_size,d.scan_status,d.created_at,d.application_id
             FROM candidate_documents d WHERE d.tenant_id=$1 AND d.candidate_id=$2
             ORDER BY ${applicationResumeOrder('d', '$3::uuid')}`,
            [actor.tenantId, row.candidate_id, id],
          )
        : [];
      const documents = resumes.slice(0, 1).map((document) => ({
        ...document,
        sent_with:
          document.application_id === id
            ? 'this_application'
            : document.application_id
              ? 'another_application'
              : 'uploaded_by_staff',
      }));
      await audit(tx, actor, 'application.details_viewed', 'application', id, {
        payAndContact: open,
      });
      return {
        id: row.id,
        stage: row.stage,
        created_at: row.created_at,
        job: { id: row.job_id, title: row.job_title },
        candidate: {
          id: row.candidate_id,
          full_name: row.full_name,
          erased: row.erased_at !== null,
          email: open ? row.email : null,
          phone: open ? (row.phone ?? row.candidate_phone) : null,
        },
        details: row.has_details
          ? {
              current_location: row.current_location,
              willing_to_relocate: row.willing_to_relocate,
              total_experience_months: row.total_experience_months,
              current_company: row.current_company,
              current_title: row.current_title,
              notice_period: row.notice_period,
              last_working_day: row.last_working_day,
              current_ctc: open ? money(row.current_ctc) : null,
              expected_ctc: open ? money(row.expected_ctc) : null,
              ctc_currency: open ? row.ctc_currency : null,
              linkedin_url: row.linkedin_url,
              portfolio_url: row.portfolio_url,
              cover_letter: row.cover_letter,
              source: row.source,
              referrer: row.referrer,
            }
          : null,
        documents,
        other_resumes: Math.max(0, resumes.length - 1),
        pay_and_contact_hidden: !open,
      };
    });
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
