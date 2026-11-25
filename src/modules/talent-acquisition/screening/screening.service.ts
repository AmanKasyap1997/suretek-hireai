import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { audit } from '../../../platform/audit/audit';
import { Actor, EvidenceActor } from '../../../shared/actor';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { AccessPolicy, ScreeningCriterion } from '../../../shared/ta-policy';
import { applicationResumeOrder } from '../../../shared/ta-resume';
import {
  ObjectStoragePort,
  ResumeTextError,
  docxText,
} from '../../../integrations';
import {
  AiDocument,
  AiProvider,
  AiProviderError,
  JsonResult,
} from '../../organization-integrations/ai-client';
import {
  AiUnavailableError,
  OrganizationAiService,
  ReadyAiConnection,
  aiProviderLabels,
} from '../../organization-integrations/organization-ai';
import {
  AssessmentError,
  Fit,
  ScreeningAnswers,
  ScreeningJob,
  ScreeningResult,
  assess,
  screeningJsonSchema,
  screeningPrompt,
  screeningSystemPrompt,
} from './screening-assessment';

export type ScreeningTrigger = 'AUTOMATIC' | 'MANUAL' | 'BATCH';
export type ScreeningStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * A screening left QUEUED or RUNNING by a restart counts as interrupted. A run
 * takes a few minutes at most (two provider attempts of up to two minutes).
 */
const STALE = `((x.status='RUNNING' AND x.started_at < now()-interval '10 minutes') OR (x.status='QUEUED' AND x.created_at < now()-interval '2 hours'))`;
const EFFECTIVE_STATUS = `CASE WHEN ${STALE} THEN 'FAILED' ELSE x.status END`;

/** Joins each application `a` to its newest screening as `s`. */
export const latestScreeningJoin = `LEFT JOIN LATERAL (SELECT x.id,${EFFECTIVE_STATUS} AS status,x.score,x.fit,x.missing_must_have FROM application_screenings x WHERE x.tenant_id=a.tenant_id AND x.application_id=a.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) s ON true`;

/** Background screenings run at most this many at a time per API process. */
const CONCURRENCY = 2;
/** Applications queued by one "screen all" request. */
const BATCH_LIMIT = 100;

export type ScreeningFailureReason =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'configuration'
  | 'refused'
  | 'incomplete'
  | 'unavailable'
  | 'invalid_output'
  | 'unreadable'
  | 'no_provider'
  | 'provider_unavailable'
  | 'reconnect'
  | 'resume_unavailable'
  | 'resume_infected'
  | 'erased'
  | 'interrupted'
  | 'error';

const failureMessages: Record<ScreeningFailureReason, (ai: string) => string> =
  {
    auth: (ai) =>
      `${ai} rejected your organization’s credentials. Ask an HR Admin to test the connection in Integrations.`,
    rate_limit: (ai) =>
      `${ai} was limiting requests. Screen again in a minute.`,
    quota: (ai) =>
      `Your organization’s ${ai} account has run out of credits or reached its usage limit. Ask an HR Admin to check billing with ${ai}.`,
    configuration: (ai) =>
      `${ai} couldn’t process the request. The deployment operator should check the configured model.`,
    refused: (ai) => `${ai} declined to screen this resume.`,
    incomplete: (ai) => `${ai} returned an incomplete answer. Screen again.`,
    unavailable: (ai) => `${ai} was unavailable. Screen again shortly.`,
    invalid_output: (ai) =>
      `${ai} returned an answer HireAI couldn’t use. Screen again.`,
    unreadable: () =>
      'The resume couldn’t be read. Check that it’s a resume with selectable text.',
    no_provider: () =>
      'No AI provider is enabled for your organization. An HR Admin must connect, test and enable OpenAI, Anthropic or Google AI Studio in Integrations.',
    provider_unavailable: (ai) =>
      `${ai} is chosen for resume screening but isn’t enabled. An HR Admin can enable it or choose another provider in Integrations.`,
    reconnect: (ai) =>
      `The ${ai} connection must be reconnected in Integrations.`,
    resume_unavailable: () =>
      'The resume couldn’t be read from storage. Screen again later.',
    resume_infected: () =>
      'The resume was blocked by the virus scan, so it wasn’t screened.',
    erased: () => 'This candidate’s personal data was erased.',
    interrupted: () => 'Screening was interrupted. Screen again.',
    error: () => 'Screening failed. Screen again.',
  };

export function screeningFailureMessage(
  reason: string,
  provider: string | null,
) {
  const ai =
    (provider && aiProviderLabels[provider as AiProvider]) || 'The AI provider';
  return (
    failureMessages[reason as ScreeningFailureReason] ?? failureMessages.error
  )(ai);
}

/**
 * Problems with one provider's account or service, rather than with the
 * resume: the next enabled provider is tried.
 */
const PROVIDER_PROBLEMS: ReadonlySet<ScreeningFailureReason> = new Set([
  'auth',
  'quota',
  'rate_limit',
  'configuration',
  'unavailable',
  'incomplete',
  'reconnect',
]);

interface ProviderAttempt {
  provider: AiProvider;
  reason: ScreeningFailureReason;
}

const providerLabel = (provider: string | null) =>
  (provider && aiProviderLabels[provider as AiProvider]) || provider;

class ScreeningFailure extends Error {
  constructor(readonly reason: ScreeningFailureReason) {
    super(`Screening failed: ${reason}`);
  }
}

function failureReason(error: unknown): ScreeningFailureReason {
  if (
    error instanceof ScreeningFailure ||
    error instanceof AiProviderError ||
    error instanceof AiUnavailableError ||
    error instanceof AssessmentError
  )
    return error.reason;
  if (error instanceof ResumeTextError) return 'unreadable';
  return 'error';
}

interface ScreeningRow {
  id: string;
  status: ScreeningStatus;
  failure: string | null;
  trigger: ScreeningTrigger;
  provider: string | null;
  model: string | null;
  score: number | null;
  fit: Fit | null;
  missing_must_have: boolean | null;
  /** A completed result, or `{attempts}` when every provider failed. */
  result:
    | (ScreeningResult & { skipped_providers?: ProviderAttempt[] })
    | { attempts?: ProviderAttempt[] }
    | null;
  document_name: string | null;
  created_at: Date;
  completed_at: Date | null;
  outdated: boolean;
}

interface RunContext extends ScreeningJob {
  erased: boolean;
  object_key: string;
  storage_version: string | null;
  content_type: string;
  sha256: string;
  scan_status: string;
  has_answers: boolean;
  total_experience_months: number | null;
  current_title: string | null;
  current_company: string | null;
  current_location: string | null;
  willing_to_relocate: boolean | null;
  notice_period: string | null;
  cover_letter: string | null;
}

@Injectable()
export class ScreeningService {
  private readonly logger = new Logger('Screening');
  private readonly waiting: { tenantId: string; id: string }[] = [];
  private active = 0;

  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
    private readonly storage: ObjectStoragePort,
    private readonly ai: OrganizationAiService,
  ) {}

  /** The newest screening of an application the actor can see. */
  async current(actor: Actor, applicationId: string) {
    await this.assertApplication(actor, applicationId);
    return {
      screening: await this.view(
        actor.tenantId,
        applicationId,
        // Like the resume itself, its file name is for recruiters.
        RECRUITMENT_ROLES.includes(actor.role),
      ),
    };
  }

  /** Why no provider can screen for this organization, or null. */
  private async unavailable(tenantId: string) {
    try {
      await this.ai.screeningConnections(tenantId);
      return null;
    } catch (error) {
      if (error instanceof AiUnavailableError)
        return screeningFailureMessage(error.reason, error.provider ?? null);
      throw error;
    }
  }

  private async assertAvailable(tenantId: string) {
    const problem = await this.unavailable(tenantId);
    if (problem) throw new ConflictException(problem);
  }

  /** Screen one application now and wait for the result (success or failure). */
  async screenNow(actor: Actor, applicationId: string) {
    await this.assertApplication(actor, applicationId);
    await this.assertAvailable(actor.tenantId);
    const id = await this.db.transaction((tx) =>
      this.request(
        tx,
        { tenantId: actor.tenantId, userId: actor.userId },
        applicationId,
        'MANUAL',
        false,
      ),
    );
    await this.run(actor.tenantId, id!);
    return {
      screening: await this.view(actor.tenantId, applicationId, true),
    };
  }

  /** Queue every unscreened (or failed) application still being considered. */
  async screenJob(actor: Actor, jobId: string) {
    await this.policy.assertJob(this.db, actor, jobId);
    await this.assertAvailable(actor.tenantId);
    const rows = await this.db.query<{ id: string }>(
      `SELECT a.id FROM applications a ${latestScreeningJoin}
       WHERE a.tenant_id=$1 AND a.job_id=$2 AND a.stage IN ('APPLIED','SHORTLISTED')
         AND (s.status IS NULL OR s.status='FAILED')
       ORDER BY a.created_at,a.id LIMIT $3`,
      [actor.tenantId, jobId, BATCH_LIMIT],
    );
    const queued: string[] = [];
    for (const row of rows) {
      const id = await this.db.transaction((tx) =>
        this.request(
          tx,
          { tenantId: actor.tenantId, userId: actor.userId },
          row.id,
          'BATCH',
          true,
        ),
      );
      if (id) queued.push(id);
    }
    await audit(this.db, actor, 'job.screening_requested', 'job', jobId, {
      queued: queued.length,
      skipped: rows.length - queued.length,
    });
    for (const id of queued) this.enqueue(actor.tenantId, id);
    return { queued: queued.length, skipped: rows.length - queued.length };
  }

  /** Screening progress for a job's applications. */
  async summary(actor: Actor, jobId: string) {
    await this.policy.assertJob(this.db, actor, jobId);
    const counts = await this.db.one<{
      total: number;
      screened: number;
      in_progress: number;
      failed: number;
      to_screen: number;
      auto_screen: boolean;
    }>(
      `SELECT count(a.id)::int AS total,
         count(a.id) FILTER (WHERE s.status='COMPLETED')::int AS screened,
         count(a.id) FILTER (WHERE s.status IN ('QUEUED','RUNNING'))::int AS in_progress,
         count(a.id) FILTER (WHERE s.status='FAILED')::int AS failed,
         count(a.id) FILTER (WHERE a.stage IN ('APPLIED','SHORTLISTED') AND (s.status IS NULL OR s.status='FAILED'))::int AS to_screen,
         bool_or(j.auto_screen) AS auto_screen
       FROM jobs j LEFT JOIN applications a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
       ${latestScreeningJoin}
       WHERE j.tenant_id=$1 AND j.id=$2`,
      [actor.tenantId, jobId],
    );
    let provider: string | null = null;
    let problem: string | null = null;
    try {
      provider = providerLabel(
        (await this.ai.screeningConnections(actor.tenantId))[0].provider,
      );
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      problem = screeningFailureMessage(error.reason, error.provider ?? null);
    }
    return {
      ...counts!,
      ai_available: !problem,
      // The provider that screens first, or why none can.
      ai_provider: provider,
      ai_message: problem,
    };
  }

  /**
   * After a public application is saved: queue a screening when the job
   * screens automatically and an AI provider is enabled. Never throws and
   * never delays the candidate's reply.
   */
  automatic(tenantId: string, applicationId: string) {
    void runWithTenant(tenantId, async () => {
      // Not screened when no provider may; the job's screening bar says why.
      if (await this.unavailable(tenantId)) return;
      const id = await this.db.transaction((tx) =>
        this.request(
          tx,
          { tenantId, userId: null },
          applicationId,
          'AUTOMATIC',
          true,
        ),
      );
      if (id) this.enqueue(tenantId, id);
    }).catch(() =>
      this.logger.warn('Automatic resume screening could not be queued'),
    );
  }

  private async assertApplication(actor: Actor, id: string) {
    const row = await this.db.one<{ job_id: string }>(
      'SELECT job_id FROM applications WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Application not found.');
    await this.policy.assertJob(this.db, actor, row.job_id);
  }

  /**
   * Adds a QUEUED screening with the job's current criteria and the
   * application's resume. `quiet` skips (returns null) where a person asking
   * would be told why instead.
   */
  private async request(
    tx: DbClient,
    actor: EvidenceActor,
    applicationId: string,
    trigger: ScreeningTrigger,
    quiet: boolean,
  ): Promise<string | null> {
    const skip = (message: string) => {
      if (quiet) return null;
      throw new ConflictException(message);
    };
    await tx.query(
      `UPDATE application_screenings x SET status='FAILED',failure='interrupted',completed_at=now()
       WHERE x.tenant_id=$1 AND x.application_id=$2 AND ${STALE}`,
      [actor.tenantId, applicationId],
    );
    // The resume sent with this application (see the ordering). Locking the
    // candidate makes a concurrent erasure wait, then delete this screening.
    const row = await tx.one<{
      criteria: ScreeningCriterion[];
      auto_screen: boolean;
      erased: boolean;
      document_id: string | null;
      scan_status: string | null;
    }>(
      `SELECT j.screening_criteria AS criteria,j.auto_screen,c.erased_at IS NOT NULL AS erased,
         r.id AS document_id,r.scan_status
       FROM applications a
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
       LEFT JOIN LATERAL (SELECT d.id,d.scan_status FROM candidate_documents d
         WHERE d.tenant_id=a.tenant_id AND d.candidate_id=a.candidate_id
         ORDER BY ${applicationResumeOrder('d', 'a.id')} LIMIT 1) r ON true
       WHERE a.tenant_id=$1 AND a.id=$2
       FOR SHARE OF c`,
      [actor.tenantId, applicationId],
    );
    if (!row) throw new NotFoundException('Application not found.');
    if (row.erased) return skip(screeningFailureMessage('erased', null));
    if (trigger === 'AUTOMATIC' && !row.auto_screen) return null;
    if (!row.document_id)
      return skip('This application has no resume to screen.');
    // Never swap in another resume: this is the one sent with the application.
    if (row.scan_status === 'INFECTED')
      return skip(screeningFailureMessage('resume_infected', null));
    const inserted = await tx.one<{ id: string }>(
      `INSERT INTO application_screenings(tenant_id,application_id,document_id,trigger,requested_by,criteria)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,application_id) WHERE status IN ('QUEUED','RUNNING') DO NOTHING
       RETURNING id`,
      [
        actor.tenantId,
        applicationId,
        row.document_id,
        trigger,
        actor.userId,
        JSON.stringify(row.criteria ?? []),
      ],
    );
    if (!inserted) return skip('This application is already being screened.');
    return inserted.id;
  }

  private enqueue(tenantId: string, id: string) {
    this.waiting.push({ tenantId, id });
    this.drain();
  }

  private drain() {
    while (this.active < CONCURRENCY && this.waiting.length) {
      const next = this.waiting.shift()!;
      this.active++;
      // Each run sets its own organization; it never inherits the context of
      // whichever request happened to start the queue.
      void runWithTenant(next.tenantId, () => this.run(next.tenantId, next.id))
        .catch(() => this.logger.warn('Resume screening failed unexpectedly'))
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  /** Runs one QUEUED screening to COMPLETED or FAILED. */
  private async run(tenantId: string, id: string) {
    const claimed = await this.db.transaction(async (tx) => {
      const started = await tx.one<{
        application_id: string;
        document_id: string;
        criteria: ScreeningCriterion[];
        trigger: ScreeningTrigger;
        requested_by: string | null;
      }>(
        `UPDATE application_screenings SET status='RUNNING',started_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='QUEUED'
         RETURNING application_id,document_id,criteria,trigger,requested_by`,
        [tenantId, id],
      );
      if (!started) return null;
      const context = await tx.one<RunContext>(
        `SELECT j.title,j.department,j.location,j.employment_type,j.description,
           c.erased_at IS NOT NULL AS erased,
           d.object_key,d.storage_version,d.content_type,d.sha256,d.scan_status,
           det.application_id IS NOT NULL AS has_answers,det.total_experience_months,det.current_title,
           det.current_company,det.current_location,det.willing_to_relocate,det.notice_period,det.cover_letter
         FROM applications a
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
         JOIN candidate_documents d ON d.tenant_id=a.tenant_id AND d.id=$3
         LEFT JOIN application_details det ON det.tenant_id=a.tenant_id AND det.application_id=a.id
         WHERE a.tenant_id=$1 AND a.id=$2`,
        [tenantId, started.application_id, started.document_id],
      );
      return { started, context };
    });
    if (!claimed) return;
    const { started, context } = claimed;
    const actor: EvidenceActor = { tenantId, userId: started.requested_by };
    const evidence = { screeningId: id, trigger: started.trigger };
    let connection: ReadyAiConnection | undefined;
    const attempts: ProviderAttempt[] = [];
    try {
      if (!context || context.erased) throw new ScreeningFailure('erased');
      if (context.scan_status === 'INFECTED')
        throw new ScreeningFailure('resume_infected');
      const document = await this.document(context);
      const request = {
        system: screeningSystemPrompt,
        prompt: screeningPrompt(
          context,
          started.criteria,
          context.has_answers ? (context as ScreeningAnswers) : null,
        ),
        document,
        schema: screeningJsonSchema,
        schemaName: 'resume_screening',
      };
      // The preferred provider first; if its account or service fails (for
      // example, no credits), the organization's next enabled provider.
      let reply: JsonResult | undefined;
      for (const candidate of await this.ai.screeningConnections(tenantId)) {
        // Set first, so a failure is recorded against the provider tried.
        connection = candidate;
        try {
          reply = await candidate.json(request);
          break;
        } catch (error) {
          const reason = failureReason(error);
          attempts.push({ provider: candidate.provider, reason });
          if (!PROVIDER_PROBLEMS.has(reason)) throw error;
        }
      }
      if (!reply) throw new ScreeningFailure(attempts.at(-1)!.reason);
      const assessment = assess(started.criteria, reply.value);
      const result = attempts.length
        ? { ...assessment.result, skipped_providers: attempts }
        : assessment.result;
      await this.db.transaction(async (tx) => {
        const done = await tx.one(
          `UPDATE application_screenings SET status='COMPLETED',provider=$3,environment=$4,model=$5,
             score=$6,fit=$7,missing_must_have=$8,result=$9,completed_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='RUNNING' RETURNING id`,
          [
            tenantId,
            id,
            connection!.provider,
            connection!.environment,
            reply.model.slice(0, 200),
            assessment.score,
            assessment.fit,
            assessment.missing_must_have,
            JSON.stringify(result),
          ],
        );
        // The resume text and the AI's wording stay out of the audit trail.
        if (done)
          await audit(
            tx,
            actor,
            'application.screened',
            'application',
            started.application_id,
            {
              ...evidence,
              provider: connection!.provider,
              environment: connection!.environment,
              model: reply!.model.slice(0, 200),
              score: assessment.score,
              fit: assessment.fit,
              ...(attempts.length ? { skippedProviders: attempts } : {}),
            },
          );
      });
    } catch (error) {
      const reason = failureReason(error);
      if (error instanceof AssessmentError && error.detail)
        this.logger.warn(
          `Screening reply from ${connection?.provider ?? 'AI'} unusable: ${error.detail}`,
        );
      // The last provider tried, if any.
      const provider =
        connection?.provider ??
        (error instanceof AiUnavailableError ? error.provider : undefined);
      await this.db.transaction(async (tx) => {
        const failed = await tx.one(
          `UPDATE application_screenings SET status='FAILED',failure=$3,provider=$4,environment=$5,result=$6,completed_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='RUNNING' RETURNING id`,
          [
            tenantId,
            id,
            reason,
            provider ?? null,
            connection?.environment ?? null,
            // Why each provider failed, when more than one was tried.
            attempts.length > 1 ? JSON.stringify({ attempts }) : null,
          ],
        );
        if (failed)
          await audit(
            tx,
            actor,
            'application.screening_failed',
            'application',
            started.application_id,
            {
              ...evidence,
              reason,
              provider: provider ?? null,
              ...(attempts.length > 1 ? { attempts } : {}),
            },
          );
      });
    }
  }

  /** The resume as the AI reads it: a PDF as is, a Word file as its text. */
  private async document(context: RunContext): Promise<AiDocument> {
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(
        context.object_key,
        context.storage_version ?? undefined,
      );
    } catch {
      throw new ScreeningFailure('resume_unavailable');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== context.sha256)
      throw new ScreeningFailure('resume_unavailable');
    // A neutral file name: the stored one often contains the candidate's name.
    if (context.content_type === 'application/pdf')
      return {
        kind: 'pdf',
        filename: 'resume.pdf',
        base64: bytes.toString('base64'),
      };
    const text = docxText(bytes);
    if (text.length < 40) throw new ScreeningFailure('unreadable');
    return { kind: 'text', filename: 'resume.docx', text };
  }

  private async view(
    tenantId: string,
    applicationId: string,
    showDocument: boolean,
  ) {
    const row = await this.db.one<ScreeningRow>(
      `SELECT x.id,${EFFECTIVE_STATUS} AS status,CASE WHEN ${STALE} THEN 'interrupted' ELSE x.failure END AS failure,
         x.trigger,x.provider,x.model,x.score,x.fit,x.missing_must_have,x.result,x.created_at,x.completed_at,
         x.criteria IS DISTINCT FROM j.screening_criteria AS outdated,d.original_name AS document_name
       FROM application_screenings x
       JOIN applications a ON a.tenant_id=x.tenant_id AND a.id=x.application_id
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       LEFT JOIN candidate_documents d ON d.tenant_id=x.tenant_id AND d.id=x.document_id
       WHERE x.tenant_id=$1 AND x.application_id=$2
       ORDER BY x.created_at DESC,x.id DESC LIMIT 1`,
      [tenantId, applicationId],
    );
    if (!row) return null;
    const completed = row.status === 'COMPLETED';
    const skipped =
      completed && row.result && 'skipped_providers' in row.result
        ? (row.result.skipped_providers ?? [])
        : [];
    const attempts =
      !completed && row.result && 'attempts' in row.result
        ? (row.result.attempts ?? [])
        : [];
    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      score: row.score,
      fit: row.fit,
      missing_must_have: row.missing_must_have,
      result: completed ? row.result : null,
      document_name: showDocument ? row.document_name : null,
      // A provider that couldn't be used, so the next one screened instead.
      fallback_message: skipped.length
        ? `${providerLabel(row.provider)} screened this resume because ${skipped
            .map((attempt) => providerLabel(attempt.provider))
            .join(' and ')} couldn’t be used. ${skipped
            .map((attempt) =>
              screeningFailureMessage(attempt.reason, attempt.provider),
            )
            .join(' ')}`
        : null,
      provider: row.provider,
      provider_label: row.provider
        ? (aiProviderLabels[row.provider as AiProvider] ?? row.provider)
        : null,
      model: row.model,
      failure: row.failure,
      failure_message: !row.failure
        ? null
        : attempts.length > 1
          ? attempts
              .map((attempt) =>
                screeningFailureMessage(attempt.reason, attempt.provider),
              )
              .join(' ')
          : screeningFailureMessage(row.failure, row.provider),
      created_at: row.created_at,
      completed_at: row.completed_at,
      // The job's criteria changed after this screening.
      outdated: row.status === 'COMPLETED' && row.outdated,
    };
  }
}
