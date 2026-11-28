import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { audit } from '../../../platform/audit/audit';
import { readConfig } from '../../../platform/config';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import {
  ApplicationStage,
  CallRequestStatus,
  ConsentScope,
  JobStatus,
} from '../../../shared/enums';
import { aiSettings } from '../../organization-integrations/organization-ai';
import {
  E164,
  PlivoError,
  plivoCall,
  plivoConnection,
} from '../../organization-integrations/plivo';
import { nextCallingTime } from './calling.policy';
import { CallingClock } from './calling.clock';
import { callLinks } from './call-links';
import { CallRecordsService } from './call-records.service';
import { callingRules, voiceOptions } from './call-setup';
import {
  BookingProblem,
  InterviewBookingService,
  Slot,
} from './interview-booking';

const ELIGIBLE: ApplicationStage[] = [
  ApplicationStage.SHORTLISTED,
  ApplicationStage.INTERVIEW,
];

interface DueRequest {
  id: string;
  application_id: string;
  recording: boolean;
  transcription: boolean;
  attempts: number;
  candidate_id: string;
  stage: ApplicationStage;
  job_status: JobStatus;
  erased_at: Date | null;
  phone: string | null;
}

type Decision =
  | { action: 'dial' }
  | { action: 'wait'; until: Date }
  | { action: 'fail'; failure: string }
  | { action: 'cancel' };

/**
 * Places due AI calls. Every check is made again when dialing: calling
 * hours, the platform's pause, the organization's setup, the application's
 * stage and the candidate's current consent (as given on the application,
 * or later through staff).
 */
@Injectable()
export class CallDispatchService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CallDispatchService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;

  constructor(
    private readonly db: DbService,
    private readonly records: CallRecordsService,
    private readonly clock: CallingClock,
    private readonly host: HttpAdapterHost,
    private readonly booking: InterviewBookingService,
  ) {}

  onApplicationBootstrap() {
    // Only the API process dials; scripts that load the app don't.
    if (!this.host.httpAdapter) return;
    const cfg = readConfig();
    const seconds =
      cfg.CALL_DISPATCH_INTERVAL_SECONDS ?? (cfg.NODE_ENV === 'test' ? 0 : 15);
    if (seconds > 0) {
      this.timer = setInterval(() => void this.tick(), seconds * 1000);
      this.timer.unref();
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Dial soon (e.g. right after a recruiter asked for a call). */
  wake() {
    if (this.timer) setImmediate(() => void this.tick());
  }

  /** One pass over every organization with calls waiting or in progress. */
  async tick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const organizations = await this.db.query<{ id: string }>(
          'SELECT call_dispatch_organizations($1) AS id',
          [500],
        );
        for (const { id } of organizations)
          try {
            await runWithTenant(id, () => this.organization(id));
          } catch {
            this.logger.warn('Call dispatch failed for an organization');
          }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  async organization(tenantId: string) {
    await this.recoverStale(tenantId);
    const cfg = readConfig();
    const busy = await this.db.one<{ count: number }>(
      "SELECT count(*)::int AS count FROM call_requests WHERE tenant_id=$1 AND status='IN_PROGRESS'",
      [tenantId],
    );
    const free = cfg.CALL_MAX_CONCURRENT - (busy?.count ?? 0);
    if (free <= 0) return;
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM call_requests WHERE tenant_id=$1 AND status='PLANNED'
         AND next_attempt_at<=$3 ORDER BY next_attempt_at,id LIMIT $2`,
      [tenantId, free, this.clock.now()],
    );
    for (const { id } of due) await this.dispatch(tenantId, id);
  }

  /** Attempts Plivo never reported back on. */
  private async recoverStale(tenantId: string) {
    const cfg = readConfig();
    const now = this.clock.now().getTime();
    const ringing = new Date(now - (cfg.CALL_RING_SECONDS + 180) * 1000);
    const talking = new Date(now - (cfg.CALL_MAX_SECONDS + 300) * 1000);
    const stale = await this.db.query<{ id: string; answered: boolean }>(
      `SELECT id,answered_at IS NOT NULL AS answered FROM call_attempts
       WHERE tenant_id=$1 AND ((status='DIALING' AND created_at<$2)
         OR (status='IN_PROGRESS' AND coalesce(answered_at,created_at)<$3))`,
      [tenantId, ringing, talking],
    );
    for (const attempt of stale)
      await this.records.finishAttempt(
        tenantId,
        attempt.id,
        attempt.answered
          ? { status: 'FAILED', failure: 'no_result', retry: true }
          : { status: 'NO_ANSWER' },
      );
  }

  private async decide(
    tx: DbClient,
    tenantId: string,
    request: DueRequest,
  ): Promise<Decision> {
    const rules = await callingRules(tx);
    const now = this.clock.now();
    if (!rules.enabled) return { action: 'fail', failure: 'server_off' };
    if (rules.paused)
      return { action: 'wait', until: new Date(now.getTime() + 15 * 60_000) };
    const next = nextCallingTime(rules.policies, now);
    if (!next) return { action: 'fail', failure: 'server_off' };
    if (next.getTime() > now.getTime()) return { action: 'wait', until: next };
    if (request.erased_at) return { action: 'cancel' };
    if (!(await aiSettings(tx, tenantId)).callingEnabled)
      return { action: 'fail', failure: 'calling_off' };
    if (
      !ELIGIBLE.includes(request.stage) ||
      request.job_status !== JobStatus.PUBLISHED
    )
      return { action: 'fail', failure: 'not_eligible' };
    if (!request.phone || !E164.test(request.phone))
      return { action: 'fail', failure: 'no_phone' };
    if (!readConfig().PUBLIC_API_BASE_URL)
      return { action: 'fail', failure: 'not_configured' };
    return { action: 'dial' };
  }

  /** Dials one due request, or postpones or fails it. */
  async dispatch(tenantId: string, requestId: string) {
    const cfg = readConfig();
    // A booking call offers interview times the panel is free: found before
    // the transaction, as that asks the calendar.
    const kind = await this.db.one<{ purpose: string; application_id: string }>(
      `SELECT purpose,application_id FROM call_requests
       WHERE tenant_id=$1 AND id=$2 AND status='PLANNED' AND next_attempt_at<=$3`,
      [tenantId, requestId, this.clock.now()],
    );
    let slots: Slot[] | null = null;
    let noSlots: string | null = null;
    if (kind?.purpose === 'SCHEDULING')
      try {
        slots = await this.booking.offer(tenantId, kind.application_id);
      } catch (error) {
        if (!(error instanceof BookingProblem)) throw error;
        noSlots = error.failure;
      }
    const plan = await this.db.transaction(async (tx) => {
      // Candidate before request, the same lock order as consent changes.
      const candidate = await tx.one<{ candidate_id: string }>(
        `SELECT a.candidate_id FROM call_requests cr
         JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
         WHERE cr.tenant_id=$1 AND cr.id=$2`,
        [tenantId, requestId],
      );
      if (!candidate) return null;
      await tx.query(
        'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
        [tenantId, candidate.candidate_id],
      );
      const request = await tx.one<DueRequest>(
        `SELECT cr.id,cr.application_id,cr.recording,cr.transcription,cr.attempts,
           a.candidate_id,a.stage,j.status AS job_status,c.erased_at,coalesce(d.phone,c.phone) AS phone
         FROM call_requests cr
         JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
         LEFT JOIN application_details d ON d.tenant_id=a.tenant_id AND d.application_id=a.id
         WHERE cr.tenant_id=$1 AND cr.id=$2 AND cr.status='PLANNED' AND cr.next_attempt_at<=$3
         FOR UPDATE OF cr SKIP LOCKED`,
        [tenantId, requestId, this.clock.now()],
      );
      if (!request) return null;
      let decision = await this.decide(tx, tenantId, request);
      const consents = await tx.query<{
        scope: ConsentScope;
        granted: boolean;
      }>(
        `SELECT DISTINCT ON (scope) scope,granted FROM consents
         WHERE tenant_id=$1 AND candidate_id=$2 AND (verified OR source='public-careers') ORDER BY scope,sequence_id DESC`,
        [tenantId, request.candidate_id],
      );
      const granted = (scope: ConsentScope) =>
        consents.some((c) => c.scope === scope && c.granted);
      if (decision.action === 'dial' && !granted(ConsentScope.CALL))
        decision = { action: 'fail', failure: 'no_consent' };
      const phone =
        decision.action === 'dial' ? await plivoConnection(tx, tenantId) : null;
      if (decision.action === 'dial' && !phone?.credentials)
        decision = { action: 'fail', failure: 'no_phone_provider' };
      if (
        decision.action === 'dial' &&
        !(await voiceOptions(tx, tenantId)).length
      )
        decision = { action: 'fail', failure: 'no_voice_ai' };
      if (decision.action === 'dial' && noSlots)
        decision = { action: 'fail', failure: noSlots };
      const evidence = { tenantId, userId: null };
      if (decision.action === 'wait') {
        await tx.query(
          'UPDATE call_requests SET next_attempt_at=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, requestId, decision.until],
        );
        return null;
      }
      if (decision.action === 'cancel' || decision.action === 'fail') {
        const cancel = decision.action === 'cancel';
        const failure = decision.action === 'fail' ? decision.failure : null;
        await tx.query(
          `UPDATE call_requests SET status=$3,outcome=$4,failure=$5,completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            requestId,
            cancel ? CallRequestStatus.CANCELLED : CallRequestStatus.FAILED,
            cancel ? null : 'FAILED',
            failure,
          ],
        );
        await audit(
          tx,
          evidence,
          cancel ? 'call_request.cancelled' : 'call.failed',
          'call_request',
          requestId,
          cancel ? { reason: 'candidate_erased' } : { failure },
        );
        return null;
      }
      const attempt = await tx.one<{ id: string; number: number }>(
        `INSERT INTO call_attempts(tenant_id,call_request_id,number,connection_id,recording,transcription,slots)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,number`,
        [
          tenantId,
          requestId,
          request.attempts + 1,
          phone!.id,
          request.recording && granted(ConsentScope.RECORDING),
          request.transcription && granted(ConsentScope.TRANSCRIPTION),
          slots ? JSON.stringify(slots) : null,
        ],
      );
      await tx.query(
        `UPDATE call_requests SET status='IN_PROGRESS',attempts=attempts+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, requestId],
      );
      await audit(tx, evidence, 'call.dialing', 'call_request', requestId, {
        attempt: attempt!.number,
        phoneEnvironment: phone!.environment,
      });
      return {
        attemptId: attempt!.id,
        to: request.phone!,
        credentials: phone!.credentials!,
      };
    });
    if (!plan) return;
    const links = callLinks(tenantId, plan.attemptId)!;
    try {
      const requestUuid = await plivoCall(plan.credentials, {
        to: plan.to,
        answerUrl: links.answerUrl,
        hangupUrl: links.hangupUrl,
        ringSeconds: cfg.CALL_RING_SECONDS,
        maxSeconds: cfg.CALL_MAX_SECONDS,
      });
      await this.db.query(
        `UPDATE call_attempts SET provider_request_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND provider_request_id IS NULL`,
        [tenantId, plan.attemptId, requestUuid],
      );
    } catch (error) {
      const reason = error instanceof PlivoError ? error.reason : 'network';
      this.logger.warn(`Plivo didn't place a call (${reason})`);
      await this.records.finishAttempt(tenantId, plan.attemptId, {
        status: 'FAILED',
        failure:
          reason === 'auth'
            ? 'phone_auth'
            : reason === 'rejected'
              ? 'dial_rejected'
              : 'dial_failed',
        retry: reason === 'network',
      });
    }
  }
}
