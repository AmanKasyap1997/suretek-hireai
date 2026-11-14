import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Actor } from '../common/actor';
import { audit } from '../common/audit';
import { DbClient, DbService } from '../database/db.service';
import { callPolicyFromEnv, isWithinCallingWindow } from './calling.policy';
import { CallingClock } from './calling.clock';
import {
  CallRequestInput,
  CallingPagination,
  ConsentInput,
} from './calling.schemas';

interface ApplicationRow {
  id: string;
  candidate_id: string;
  stage: string;
  job_status: string;
}

interface ConsentRow {
  id: string;
  scope: string;
  granted: boolean;
  source: string;
  created_at: Date;
}

interface CallRequestRow {
  id: string;
  application_id: string;
  language: string;
  recording: boolean;
  transcription: boolean;
  status: string;
  idempotency_key: string;
  created_at: Date;
}

@Injectable()
export class CallingService {
  private readonly policy = callPolicyFromEnv();

  constructor(
    private readonly db: DbService,
    private readonly clock: CallingClock,
  ) {}

  async recordConsent(actor: Actor, candidateId: string, input: ConsentInput) {
    return this.db.transaction(async (tx) => {
      await this.lockCandidate(tx, actor, candidateId);
      const consent = await tx.one<ConsentRow>(
        `INSERT INTO consents (tenant_id,candidate_id,scope,granted,source,captured_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
         RETURNING id,scope,granted,source,created_at`,
        [
          actor.tenantId,
          candidateId,
          input.scope,
          input.granted,
          input.source,
          actor.userId,
        ],
      );
      if (!input.granted) {
        const cancelled = await tx.query<{ id: string }>(
          `UPDATE call_requests cr SET status='CANCELLED'
           FROM applications a
           WHERE cr.tenant_id=$1 AND a.tenant_id=cr.tenant_id AND a.id=cr.application_id
             AND a.candidate_id=$2 AND cr.status='PLANNED'
             AND ($3='CALL' OR ($3='RECORDING' AND cr.recording) OR ($3='TRANSCRIPTION' AND cr.transcription))
           RETURNING cr.id`,
          [actor.tenantId, candidateId, input.scope],
        );
        for (const request of cancelled) {
          await audit(
            tx,
            actor,
            'call_request.cancelled_by_consent',
            'call_request',
            request.id,
            { scope: input.scope },
          );
        }
      }
      await audit(tx, actor, 'consent.recorded', 'consent', consent!.id, {
        candidateId,
        scope: input.scope,
        granted: input.granted,
      });
      return consent;
    });
  }

  async listConsents(
    actor: Actor,
    candidateId: string,
    pagination: CallingPagination,
  ) {
    const candidate = await this.db.one<{ id: string }>(
      'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, candidateId],
    );
    if (!candidate) throw new NotFoundException('Candidate not found');
    const data = await this.db.query<ConsentRow>(
      `SELECT id,scope,granted,source,created_at FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY sequence_id DESC LIMIT $3 OFFSET $4`,
      [actor.tenantId, candidateId, pagination.limit, pagination.offset],
    );
    const latest = await this.db.query<ConsentRow>(
      `SELECT DISTINCT ON (scope) id,scope,granted,source,created_at FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY scope,sequence_id DESC`,
      [actor.tenantId, candidateId],
    );
    return { data, latest, pagination };
  }

  async planCall(actor: Actor, input: CallRequestInput) {
    return this.db.transaction(async (tx) => {
      // Lock candidate first, so consent revocations and plan creation serialize.
      const application = await tx.one<ApplicationRow>(
        `SELECT id,candidate_id,stage FROM applications WHERE tenant_id=$1 AND id=$2`,
        [actor.tenantId, input.applicationId],
      );
      if (!application) throw new NotFoundException('Application not found');
      await this.lockCandidate(tx, actor, application.candidate_id);
      const existing = await tx.one<CallRequestRow>(
        `SELECT id,application_id,language,recording,transcription,status,idempotency_key,created_at
         FROM call_requests WHERE tenant_id=$1 AND idempotency_key=$2`,
        [actor.tenantId, input.idempotencyKey],
      );
      if (existing) {
        if (
          existing.application_id !== input.applicationId ||
          existing.language !== input.language ||
          existing.recording !== input.recording ||
          existing.transcription !== input.transcription
        ) {
          throw new ConflictException(
            'Idempotency key has already been used for a different request',
          );
        }
        return existing;
      }
      if (!this.policy.enabled)
        throw new ForbiddenException('Call planning is disabled');
      if (!isWithinCallingWindow(this.policy, this.clock.now())) {
        throw new ForbiddenException(
          'Outside the configured local calling window',
        );
      }
      const current = await tx.one<ApplicationRow>(
        `SELECT a.id,a.candidate_id,a.stage,j.status AS job_status FROM applications a
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         WHERE a.tenant_id=$1 AND a.id=$2 FOR SHARE OF a,j`,
        [actor.tenantId, input.applicationId],
      );
      if (
        !current ||
        !['SHORTLISTED', 'INTERVIEW'].includes(current.stage) ||
        current.job_status !== 'PUBLISHED'
      ) {
        throw new ConflictException(
          'Call planning requires a shortlisted/interview application for a published job',
        );
      }
      const consents = await tx.query<{ scope: string; granted: boolean }>(
        `SELECT DISTINCT ON (scope) scope,granted FROM consents
         WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY scope,sequence_id DESC`,
        [actor.tenantId, current.candidate_id],
      );
      const required = [
        'CALL',
        ...(input.recording ? ['RECORDING'] : []),
        ...(input.transcription ? ['TRANSCRIPTION'] : []),
      ];
      for (const scope of required) {
        if (
          !consents.some(
            (consent) => consent.scope === scope && consent.granted,
          )
        ) {
          throw new ForbiddenException(
            `Current ${scope.toLowerCase()} consent is required`,
          );
        }
      }
      const request = await tx.one<CallRequestRow>(
        `INSERT INTO call_requests (tenant_id,application_id,requested_by,language,recording,transcription,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,application_id,language,recording,transcription,status,idempotency_key,created_at`,
        [
          actor.tenantId,
          input.applicationId,
          actor.userId,
          input.language,
          input.recording,
          input.transcription,
          input.idempotencyKey,
        ],
      );
      await audit(
        tx,
        actor,
        'call_request.planned',
        'call_request',
        request!.id,
        {
          applicationId: input.applicationId,
          language: input.language,
          recording: input.recording,
          transcription: input.transcription,
        },
      );
      return request;
    });
  }

  async listCalls(actor: Actor, pagination: CallingPagination) {
    const data = await this.db.query<CallRequestRow>(
      `SELECT id,application_id,language,recording,transcription,status,idempotency_key,created_at
       FROM call_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, pagination.limit, pagination.offset],
    );
    return { data, pagination };
  }

  async cancelCall(actor: Actor, requestId: string) {
    return this.db.transaction(async (tx) => {
      const request = await tx.one<CallRequestRow>(
        `SELECT id,application_id,language,recording,transcription,status,idempotency_key,created_at
         FROM call_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [actor.tenantId, requestId],
      );
      if (!request) throw new NotFoundException('Call request not found');
      if (request.status === 'CANCELLED') return request;
      const updated = await tx.one<CallRequestRow>(
        `UPDATE call_requests SET status='CANCELLED' WHERE tenant_id=$1 AND id=$2
         RETURNING id,application_id,language,recording,transcription,status,idempotency_key,created_at`,
        [actor.tenantId, requestId],
      );
      await audit(
        tx,
        actor,
        'call_request.cancelled',
        'call_request',
        requestId,
      );
      return updated;
    });
  }

  private async lockCandidate(tx: DbClient, actor: Actor, candidateId: string) {
    const candidate = await tx.one<{ id: string }>(
      'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
      [actor.tenantId, candidateId],
    );
    if (!candidate) throw new NotFoundException('Candidate not found');
  }
}
