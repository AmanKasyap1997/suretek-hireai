import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../database/db.service';
import { Actor } from '../common/actor';
import { audit } from '../common/audit';
import {
  ApplicationInput,
  CandidateInput,
  JobInput,
  JobUpdate,
  OfferInput,
  Pagination,
  StageInput,
} from './hiring.schemas';

interface Job {
  id: string;
  status: 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'CLOSED';
}
interface Candidate {
  id: string;
  full_name: string;
  email: string;
}
interface Application {
  id: string;
  job_id: string;
  candidate_id: string;
  stage:
    'APPLIED' | 'SHORTLISTED' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
}
interface Offer {
  id: string;
  application_id: string;
  status: 'DRAFT' | 'APPROVED' | 'ACCEPTED';
  annual_ctc: string;
  currency: string;
  joining_date: string;
}
interface Employee {
  id: string;
}

@Injectable()
export class HiringService {
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
      if (row.status !== 'DRAFT')
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

  async transitionJob(actor: Actor, id: string, target: Job['status']) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one<Job>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException('Job not found.');
      const allowed: Record<Job['status'], Job['status'][]> = {
        DRAFT: ['APPROVED', 'CLOSED'],
        APPROVED: ['PUBLISHED', 'CLOSED'],
        PUBLISHED: ['CLOSED'],
        CLOSED: [],
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

  async createCandidate(actor: Actor, input: CandidateInput) {
    return this.db.transaction(async (tx) => {
      const candidate = await tx.one<Candidate>(
        `INSERT INTO candidates (tenant_id,full_name,email,phone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [actor.tenantId, input.fullName, input.email, input.phone ?? null],
      );
      await audit(tx, actor, 'candidate.created', 'candidate', candidate!.id);
      return candidate;
    });
  }

  async listCandidates(actor: Actor, page: Pagination) {
    const data = await this.db.query<Candidate>(
      `SELECT * FROM candidates WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getCandidate(actor: Actor, id: string) {
    const row = await this.db.one<Candidate>(
      'SELECT * FROM candidates WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Candidate not found.');
    return row;
  }

  async createApplication(actor: Actor, input: ApplicationInput) {
    return this.db.transaction(async (tx) => {
      const job = await tx.one<Job>(
        'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE',
        [actor.tenantId, input.jobId],
      );
      if (!job) throw new NotFoundException('Job not found.');
      if (job.status !== 'PUBLISHED')
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
      const allowed: Record<Application['stage'], string[]> = {
        APPLIED: ['SHORTLISTED', 'REJECTED'],
        SHORTLISTED: ['INTERVIEW', 'REJECTED'],
        INTERVIEW: ['REJECTED'],
        OFFER: [],
        HIRED: [],
        REJECTED: [],
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

  async createOffer(actor: Actor, input: OfferInput) {
    return this.db.transaction(async (tx) => {
      const app = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, input.applicationId],
      );
      if (!app) throw new NotFoundException('Application not found.');
      if (!['SHORTLISTED', 'INTERVIEW'].includes(app.stage))
        throw new ConflictException(
          'Shortlist or interview the candidate before drafting an offer.',
        );
      const offer = await tx.one<Offer>(
        `INSERT INTO offers (tenant_id,application_id,annual_ctc,currency,joining_date,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          actor.tenantId,
          input.applicationId,
          input.annualCtc,
          input.currency,
          input.joiningDate,
          actor.userId,
        ],
      );
      await tx.query(
        'UPDATE applications SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, app.id, 'OFFER'],
      );
      await audit(tx, actor, 'offer.created', 'offer', offer!.id);
      return offer;
    });
  }

  async listOffers(actor: Actor, page: Pagination) {
    const data = await this.db.query<Offer>(
      'SELECT * FROM offers WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getOffer(actor: Actor, id: string) {
    const row = await this.db.one<Offer>(
      'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Offer not found.');
    return row;
  }

  async approveOffer(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== 'DRAFT')
        throw new ConflictException('Only draft offers can be approved.');
      const updated = await tx.one<Offer>(
        `UPDATE offers SET status='APPROVED',approved_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, actor.userId],
      );
      await audit(tx, actor, 'offer.approved', 'offer', id);
      return updated;
    });
  }

  async acceptOffer(actor: Actor, id: string, acceptanceReference: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== 'APPROVED')
        throw new ConflictException(
          'Only approved offers can have acceptance recorded.',
        );
      const updated = await tx.one<Offer>(
        `UPDATE offers SET status='ACCEPTED',accepted_at=now(),acceptance_reference=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, acceptanceReference],
      );
      // The reference is evidence metadata recorded by HR, not an electronic signature.
      await audit(tx, actor, 'offer.acceptance_recorded', 'offer', id);
      return updated;
    });
  }

  async hire(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== 'ACCEPTED')
        throw new ConflictException(
          'Record candidate acceptance before hiring.',
        );
      // Locking the offer serializes retries and concurrent requests for the same offer.
      const previous = await tx.one<Employee>(
        'SELECT * FROM employees WHERE tenant_id=$1 AND source_offer_id=$2',
        [actor.tenantId, id],
      );
      if (previous) return previous;
      const app = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, offer.application_id],
      );
      if (!app || app.stage !== 'OFFER')
        throw new ConflictException('Application is not in the offer stage.');
      const candidate = await tx.one<Candidate>(
        'SELECT * FROM candidates WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, app.candidate_id],
      );
      if (!candidate) throw new NotFoundException('Candidate not found.');
      const existing = await tx.one<Employee>(
        'SELECT id FROM employees WHERE tenant_id=$1 AND candidate_id=$2',
        [actor.tenantId, candidate.id],
      );
      if (existing)
        throw new ConflictException(
          'An employee record already exists for this candidate.',
        );
      const employeeId = randomUUID();
      const employee = await tx.one<Employee>(
        `INSERT INTO employees (id,tenant_id,candidate_id,source_offer_id,employee_code,full_name,email,joining_date,annual_ctc,currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          employeeId,
          actor.tenantId,
          candidate.id,
          id,
          `EMP-${employeeId.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
          candidate.full_name,
          candidate.email,
          offer.joining_date,
          offer.annual_ctc,
          offer.currency,
        ],
      );
      await tx.query(
        `INSERT INTO onboarding_tasks (tenant_id,employee_id,title) VALUES ($1,$2,'Collect joining documents'),
         ($1,$2,'Provision work access'),($1,$2,'Complete HR induction')`,
        [actor.tenantId, employeeId],
      );
      await tx.query(
        `UPDATE applications SET stage='HIRED',updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [actor.tenantId, app.id],
      );
      await audit(
        tx,
        actor,
        'employee.created_from_offer',
        'employee',
        employeeId,
        { offerId: id, applicationId: app.id },
      );
      return employee;
    });
  }
}
