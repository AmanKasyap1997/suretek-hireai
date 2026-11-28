import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../../../platform/config';
import { aiSettings } from '../../organization-integrations/organization-ai';
import { E164 } from '../../organization-integrations/plivo';
import { callQuestionsSchema } from '../jobs';
import { CallDispatchService } from './call-dispatch.service';
import { CallRecordsService } from './call-records.service';
import { callQuestions } from './call-script';
import { callingProblem, callingRules } from './call-setup';
import { PhoneCallsService } from './phone-calls.service';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import {
  ApplicationStage,
  CallLanguage,
  CallRequestStatus,
  ConsentScope,
  JobStatus,
} from '../../../shared/enums';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { nextCallingTime } from './calling.policy';
import { CallingClock } from './calling.clock';
import {
  CallRequestInput,
  CallingPagination,
  ConsentInput,
  JobCallsInput,
} from './calling.schemas';

const eligibleCallStages: readonly ApplicationStage[] = [
  ApplicationStage.SHORTLISTED,
  ApplicationStage.INTERVIEW,
];

interface ApplicationRow {
  id: string;
  candidate_id: string;
  stage: ApplicationStage;
  job_status: JobStatus;
}

interface ConsentRow {
  id: string;
  scope: ConsentScope;
  granted: boolean;
  source: string;
  created_at: Date;
}

interface CallRequestRow {
  id: string;
  application_id: string;
  language: CallLanguage;
  recording: boolean;
  transcription: boolean;
  status: CallRequestStatus;
  idempotency_key: string;
  next_attempt_at: Date | null;
  attempts: number;
  outcome: string | null;
  created_at: Date;
}

const requestColumns =
  'id,application_id,language,recording,transcription,status,idempotency_key,next_attempt_at,attempts,outcome,created_at';

/** A job's saved call questions; invalid entries are ignored. */
function jobQuestions(value: unknown) {
  const parsed = callQuestionsSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Who asks for a call: a person, or HireAI itself (userId null). */
export type CallRequester = { tenantId: string; userId: string | null };

/**
 * Plans an AI call within a transaction, after every check: calling on and
 * not paused, the quota, a shortlisted or interviewing application of a
 * published job, no other call planned, the candidate's consent, and (for a
 * screening call) the job's questions.
 */
export async function planCallRequest(
  tx: DbClient,
  now: Date,
  actor: CallRequester,
  input: CallRequestInput,
  options: {
    optionalConsents?: boolean;
    /** SCHEDULING: the call that books the interview. */
    purpose?: 'SCREENING' | 'SCHEDULING';
  } = {},
): Promise<CallRequestRow> {
  // Lock candidate first, so consent revocations and plan creation serialize.
  const application = await tx.one<
    Pick<ApplicationRow, 'id' | 'candidate_id' | 'stage'>
  >(
    `SELECT id,candidate_id,stage FROM applications WHERE tenant_id=$1 AND id=$2`,
    [actor.tenantId, input.applicationId],
  );
  if (!application) throw new NotFoundException('Application not found');
  await lockCandidate(tx, actor.tenantId, application.candidate_id);
  const existing = await tx.one<CallRequestRow>(
    `SELECT ${requestColumns} FROM call_requests WHERE tenant_id=$1 AND idempotency_key=$2`,
    [actor.tenantId, input.idempotencyKey],
  );
  if (existing) {
    if (
      existing.application_id !== input.applicationId ||
      existing.language !== input.language ||
      (!options.optionalConsents &&
        (existing.recording !== input.recording ||
          existing.transcription !== input.transcription))
    ) {
      throw new ConflictException(
        'Idempotency key has already been used for a different request',
      );
    }
    return existing;
  }
  const rules = await callingRules(tx);
  if (rules.paused)
    throw new ForbiddenException('Calling is paused by the platform');
  if (!rules.enabled) throw new ForbiddenException('Call planning is disabled');
  if (!(await aiSettings(tx, actor.tenantId)).callingEnabled)
    throw new ForbiddenException(
      'AI calling is off for your organization. An HR Admin can turn it on in Integrations.',
    );
  if (rules.quota !== null) {
    await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
      actor.tenantId,
    ]);
    const used = await tx.one<{ count: number }>(
      "SELECT count(*)::int AS count FROM call_requests WHERE tenant_id=$1 AND status<>'CANCELLED' AND created_at>=date_trunc('month',now())",
      [actor.tenantId],
    );
    if (used!.count >= rules.quota)
      throw new ForbiddenException('Monthly platform call quota reached');
  }
  const current = await tx.one<
    ApplicationRow & { job_id: string; call_questions: unknown }
  >(
    `SELECT a.id,a.candidate_id,a.stage,a.job_id,j.status AS job_status,j.call_questions FROM applications a
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       WHERE a.tenant_id=$1 AND a.id=$2 FOR SHARE OF a,j`,
    [actor.tenantId, input.applicationId],
  );
  if (
    !current ||
    !eligibleCallStages.includes(current.stage) ||
    current.job_status !== JobStatus.PUBLISHED
  ) {
    throw new ConflictException(
      'Call planning requires a shortlisted/interview application for a published job',
    );
  }
  if (
    await tx.one(
      `SELECT id FROM call_requests WHERE tenant_id=$1 AND application_id=$2
           AND (status='IN_PROGRESS' OR (status='PLANNED' AND next_attempt_at IS NOT NULL))`,
      [actor.tenantId, input.applicationId],
    )
  )
    throw new ConflictException(
      'A call is already scheduled or in progress for this application.',
    );
  const consents = await tx.query<{
    scope: ConsentScope;
    granted: boolean;
  }>(
    `SELECT DISTINCT ON (scope) scope,granted FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 AND (verified OR source='public-careers') ORDER BY scope,sequence_id DESC`,
    [actor.tenantId, current.candidate_id],
  );
  const granted = (scope: ConsentScope) =>
    consents.some((consent) => consent.scope === scope && consent.granted);
  let { recording, transcription } = input;
  if (options.optionalConsents) {
    recording &&= granted(ConsentScope.RECORDING);
    transcription &&= granted(ConsentScope.TRANSCRIPTION);
  }
  const required: ConsentScope[] = [
    ConsentScope.CALL,
    ...(recording ? [ConsentScope.RECORDING] : []),
    ...(transcription ? [ConsentScope.TRANSCRIPTION] : []),
  ];
  for (const scope of required) {
    if (!granted(scope)) {
      throw new ForbiddenException(
        `Current ${scope.toLowerCase()} consent is required`,
      );
    }
  }
  const purpose = options.purpose ?? 'SCREENING';
  // A booking call asks no questions: it offers interview times.
  const questions =
    purpose === 'SCHEDULING'
      ? []
      : callQuestions(
          jobQuestions(current.call_questions),
          await screeningQuestions(tx, actor.tenantId, input.applicationId),
        );
  if (purpose === 'SCREENING' && !questions.length)
    throw new ConflictException(
      'Add call questions to this job (Jobs → Call questions) before calling candidates.',
    );
  const when = nextCallingTime(rules.policies, now);
  if (!when)
    throw new ForbiddenException(
      'The calling hours never overlap, so no call can be placed',
    );
  const request = await tx.one<CallRequestRow>(
    `INSERT INTO call_requests (tenant_id,application_id,requested_by,language,recording,transcription,idempotency_key,status,questions,next_attempt_at,max_attempts,purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${requestColumns}`,
    [
      actor.tenantId,
      input.applicationId,
      actor.userId,
      input.language,
      recording,
      transcription,
      input.idempotencyKey,
      CallRequestStatus.PLANNED,
      JSON.stringify(questions),
      when,
      readConfig().CALL_MAX_ATTEMPTS,
      purpose,
    ],
  );
  await audit(tx, actor, 'call_request.planned', 'call_request', request!.id, {
    applicationId: input.applicationId,
    language: input.language,
    recording,
    transcription,
    questions: questions.length,
    scheduledFor: when.toISOString(),
    purpose,
    automatic: actor.userId === null,
  });
  return request!;
}

/** Up to two questions from the application's latest resume screening. */
async function screeningQuestions(
  tx: DbClient,
  tenantId: string,
  applicationId: string,
): Promise<string[]> {
  const row = await tx.one<{ questions: unknown }>(
    `SELECT result->'questions' AS questions FROM application_screenings
     WHERE tenant_id=$1 AND application_id=$2 AND status='COMPLETED'
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [tenantId, applicationId],
  );
  return Array.isArray(row?.questions)
    ? row.questions.filter((q): q is string => typeof q === 'string')
    : [];
}

/** Locks the candidate, so consent changes and call plans serialize. */
async function lockCandidate(
  tx: DbClient,
  tenantId: string,
  candidateId: string,
) {
  const candidate = await tx.one<{ id: string }>(
    'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 AND erased_at IS NULL FOR NO KEY UPDATE',
    [tenantId, candidateId],
  );
  if (!candidate) throw new NotFoundException('Candidate not found');
}

@Injectable()
export class CallingService {
  constructor(
    private readonly db: DbService,
    private readonly clock: CallingClock,
    private readonly records: CallRecordsService,
    private readonly dispatcher: CallDispatchService,
    private readonly phone: PhoneCallsService,
  ) {}

  async recordConsent(actor: Actor, candidateId: string, input: ConsentInput) {
    const { consent, live } = await this.db.transaction(async (tx) => {
      await lockCandidate(tx, actor.tenantId, candidateId);
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
      let live: string[] = [];
      if (!input.granted) {
        // Calls on the line are hung up once this commits.
        live = (
          await tx.query<{ id: string }>(
            `SELECT cr.id FROM call_requests cr JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
             WHERE cr.tenant_id=$1 AND a.candidate_id=$2 AND cr.status='IN_PROGRESS'
               AND ($3::text='CALL' OR ($3::text='RECORDING' AND cr.recording) OR ($3::text='TRANSCRIPTION' AND cr.transcription))`,
            [actor.tenantId, candidateId, input.scope],
          )
        ).map((r) => r.id);
        const cancelled = await tx.query<{ id: string }>(
          `UPDATE call_requests cr SET status=$4,updated_at=now()
           FROM applications a
           WHERE cr.tenant_id=$1 AND a.tenant_id=cr.tenant_id AND a.id=cr.application_id
             AND a.candidate_id=$2 AND cr.status IN ($5,'IN_PROGRESS')
             AND ($3::text=$6 OR ($3::text=$7 AND cr.recording) OR ($3::text=$8 AND cr.transcription))
           RETURNING cr.id`,
          [
            actor.tenantId,
            candidateId,
            input.scope,
            CallRequestStatus.CANCELLED,
            CallRequestStatus.PLANNED,
            ConsentScope.CALL,
            ConsentScope.RECORDING,
            ConsentScope.TRANSCRIPTION,
          ],
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
      return { consent, live };
    });
    for (const requestId of live)
      await this.phone.cancel(actor.tenantId, requestId);
    return consent;
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
      `SELECT id,scope,granted,source,created_at,verified,notice_version FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY sequence_id DESC LIMIT $3 OFFSET $4`,
      [actor.tenantId, candidateId, pagination.limit, pagination.offset],
    );
    const latest = await this.db.query<ConsentRow>(
      `SELECT DISTINCT ON (scope) id,scope,granted,source,created_at,verified,notice_version FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY scope,sequence_id DESC`,
      [actor.tenantId, candidateId],
    );
    return { data, latest, pagination };
  }

  /**
   * Asks for an AI call. HireAI dials during calling hours (now, or when the
   * next window opens) and checks everything again before dialing.
   * `optionalConsents`: call without recording/transcription when the
   * candidate didn't agree to them, instead of refusing (bulk calls).
   */
  async planCall(
    actor: Actor,
    input: CallRequestInput,
    options: { optionalConsents?: boolean } = {},
  ) {
    const request = await this.db.transaction((tx) =>
      planCallRequest(tx, this.clock.now(), actor, input, options),
    );
    if (
      request.status === CallRequestStatus.PLANNED &&
      request.next_attempt_at &&
      request.next_attempt_at.getTime() <= this.clock.now().getTime()
    )
      this.dispatcher.wake();
    return request;
  }

  /**
   * Calls every shortlisted candidate of a job who agreed to be called and
   * hasn't been called for it yet.
   */
  async callJob(actor: Actor, jobId: string, input: JobCallsInput) {
    const job = await this.db.one(
      'SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, jobId],
    );
    if (!job) throw new NotFoundException('Job not found.');
    const applications = await this.db.query<{
      id: string;
      called: boolean;
    }>(
      `SELECT a.id,EXISTS(
           SELECT 1 FROM call_requests cr WHERE cr.tenant_id=a.tenant_id AND cr.application_id=a.id
             AND (cr.status IN ('IN_PROGRESS','COMPLETED') OR (cr.status='PLANNED' AND cr.next_attempt_at IS NOT NULL))
         ) AS called
       FROM applications a JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
       WHERE a.tenant_id=$1 AND a.job_id=$2 AND a.stage=$3 AND c.erased_at IS NULL
       ORDER BY a.created_at,a.id LIMIT 200`,
      [actor.tenantId, jobId, ApplicationStage.SHORTLISTED],
    );
    const result = {
      planned: 0,
      already_called: 0,
      no_consent: 0,
      other: 0,
      problem: null as string | null,
    };
    for (const application of applications) {
      if (application.called) {
        result.already_called++;
        continue;
      }
      try {
        await this.planCall(
          actor,
          {
            applicationId: application.id,
            ...input,
            idempotencyKey: randomUUID(),
          },
          { optionalConsents: true },
        );
        result.planned++;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/consent/i.test(message)) result.no_consent++;
        else if (/already scheduled/i.test(message)) result.already_called++;
        else {
          result.other++;
          result.problem ??= message || 'The call couldn’t be requested.';
          // Organization-wide problems stop the whole batch.
          if (
            /AI calling is off|disabled|paused|quota|call questions/i.test(
              message,
            )
          )
            break;
        }
      }
    }
    await this.db.transaction((tx) =>
      audit(tx, actor, 'job.calls_requested', 'job', jobId, {
        planned: result.planned,
        alreadyCalled: result.already_called,
        noConsent: result.no_consent,
        other: result.other,
      }),
    );
    return result;
  }

  /** The calls panel on an application: whether a call can be made, and past calls. */
  async applicationCalls(actor: Actor, applicationId: string) {
    const application = await this.db.one<{
      stage: ApplicationStage;
      job_status: JobStatus;
      call_questions: unknown;
      candidate_id: string;
      erased_at: Date | null;
      phone: string | null;
    }>(
      `SELECT a.stage,j.status AS job_status,j.call_questions,a.candidate_id,c.erased_at,
         coalesce(d.phone,c.phone) AS phone
       FROM applications a
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
       LEFT JOIN application_details d ON d.tenant_id=a.tenant_id AND d.application_id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2`,
      [actor.tenantId, applicationId],
    );
    if (!application) throw new NotFoundException('Application not found');
    const consents = await this.db.query<{
      scope: ConsentScope;
      granted: boolean;
    }>(
      `SELECT DISTINCT ON (scope) scope,granted FROM consents
       WHERE tenant_id=$1 AND candidate_id=$2 AND (verified OR source='public-careers') ORDER BY scope,sequence_id DESC`,
      [actor.tenantId, application.candidate_id],
    );
    const granted = (scope: ConsentScope) =>
      consents.some((c) => c.scope === scope && c.granted);
    const calls = await this.records.applicationCalls(
      this.db,
      actor,
      applicationId,
    );
    const active = calls.some(
      (c) =>
        c.status === CallRequestStatus.IN_PROGRESS ||
        (c.status === CallRequestStatus.PLANNED && c.scheduled),
    );
    const blocked =
      (await callingProblem(this.db, actor.tenantId)) ??
      (application.erased_at
        ? 'The candidate’s data was erased.'
        : !eligibleCallStages.includes(application.stage)
          ? 'Shortlist the application (or move it to interview) to call the candidate.'
          : application.job_status !== JobStatus.PUBLISHED
            ? 'The job isn’t published.'
            : !granted(ConsentScope.CALL)
              ? 'The candidate chose not to be called on their application.'
              : !application.phone || !E164.test(application.phone)
                ? 'The candidate has no phone number in international format.'
                : !jobQuestions(application.call_questions).length
                  ? 'Add call questions to this job before calling candidates.'
                  : active
                    ? 'A call is already scheduled or in progress.'
                    : null);
    return {
      can_call: !blocked,
      blocked,
      consents: {
        call: granted(ConsentScope.CALL),
        recording: granted(ConsentScope.RECORDING),
        transcription: granted(ConsentScope.TRANSCRIPTION),
      },
      calls,
    };
  }

  async listCalls(actor: Actor, pagination: CallingPagination) {
    const data = await this.db.query<CallRequestRow>(
      `SELECT ${requestColumns}
       FROM call_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, pagination.limit, pagination.offset],
    );
    return { data, pagination };
  }

  /** Cancels a waiting call, or hangs up one that's on the line. */
  async cancelCall(actor: Actor, requestId: string) {
    const { updated, live } = await this.db.transaction(async (tx) => {
      const request = await tx.one<CallRequestRow>(
        `SELECT ${requestColumns}
         FROM call_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [actor.tenantId, requestId],
      );
      if (!request) throw new NotFoundException('Call request not found');
      if (request.status === CallRequestStatus.CANCELLED)
        return { updated: request, live: false };
      if (
        request.status === CallRequestStatus.COMPLETED ||
        request.status === CallRequestStatus.FAILED
      )
        throw new ConflictException('This call has already ended.');
      const updated = await tx.one<CallRequestRow>(
        `UPDATE call_requests SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2
         RETURNING ${requestColumns}`,
        [actor.tenantId, requestId, CallRequestStatus.CANCELLED],
      );
      await audit(
        tx,
        actor,
        'call_request.cancelled',
        'call_request',
        requestId,
        { during: request.status },
      );
      return {
        updated: updated!,
        live: request.status === CallRequestStatus.IN_PROGRESS,
      };
    });
    if (live) await this.phone.cancel(actor.tenantId, requestId);
    return updated;
  }
}
