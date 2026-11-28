import { Injectable, Logger } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { HiringAutomationService } from './hiring-automation.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { AiProviderError } from '../../organization-integrations/ai-client';
import {
  AiUnavailableError,
  OrganizationAiService,
  aiProviderLabels,
} from '../../organization-integrations/organization-ai';
import {
  assessedQuestions,
  callAssessment,
  callAssessmentJsonSchema,
  callAssessmentPrompt,
  callAssessmentSystemPrompt,
} from './call-assessment';
import { CallAnswer, CallQuestion } from './call-script';

/** Account and service problems: the next enabled provider is tried. */
const PROVIDER_PROBLEMS = new Set([
  'auth',
  'quota',
  'rate_limit',
  'configuration',
  'unavailable',
  'incomplete',
]);

/** Why an assessment failed, for recruiters. */
export const assessmentFailureMessages: Record<string, string> = {
  no_provider:
    'No AI provider is enabled for screening. An HR Admin can enable one in Integrations.',
  provider_unavailable:
    'The AI provider chosen for screening isn’t enabled. An HR Admin can check Integrations.',
  reconnect: 'The screening AI provider must be reconnected in Integrations.',
  quota: 'The screening AI provider has run out of credits or hit its limit.',
  auth: 'The screening AI provider didn’t accept its key.',
  rate_limit: 'The screening AI provider is busy. Try again in a minute.',
  unavailable: 'The screening AI provider is unavailable. Try again later.',
  stalled: 'The assessment didn’t finish. Try again.',
};

function failureReason(error: unknown) {
  if (error instanceof AiUnavailableError) return error.reason;
  if (error instanceof AiProviderError) return error.reason;
  return 'unavailable';
}

/**
 * Rates a call's answers with the organization's screening AI, after the
 * call. A suggestion for the recruiter; it never changes a stage.
 */
@Injectable()
export class CallAssessmentService {
  private readonly logger = new Logger(CallAssessmentService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly db: DbService,
    private readonly ai: OrganizationAiService,
    private readonly automation: HiringAutomationService,
  ) {}

  /**
   * Picks up assessments a restart left behind: started but never finished,
   * or never started, for calls that got answers.
   */
  async recover(tenantId: string) {
    const left = await this.db.query<{ id: string }>(
      `SELECT id FROM call_attempts
       WHERE tenant_id=$1 AND status='COMPLETED'
         AND jsonb_array_length(coalesce(answers,'[]'::jsonb))>0
         AND updated_at>now()-interval '2 days'
         AND ((assessment_status='PENDING' AND updated_at<now()-interval '10 minutes')
           OR (assessment_status IS NULL AND updated_at<now()-interval '2 minutes'))`,
      [tenantId],
    );
    for (const { id } of left) this.queue(tenantId, id);
  }

  /** Assesses in the background. */
  queue(tenantId: string, attemptId: string) {
    setImmediate(() => {
      this.assess(tenantId, attemptId).catch(() =>
        this.logger.warn('A call assessment couldn’t be saved'),
      );
    });
  }

  async assess(tenantId: string, attemptId: string) {
    if (this.running.has(attemptId)) return;
    this.running.add(attemptId);
    try {
      await runWithTenant(tenantId, () => this.run(tenantId, attemptId));
    } finally {
      this.running.delete(attemptId);
    }
  }

  private async run(tenantId: string, attemptId: string) {
    const row = await this.db.one<{
      call_request_id: string;
      answers: CallAnswer[] | null;
      questions: CallQuestion[];
      title: string;
      description: string | null;
    }>(
      `SELECT ca.call_request_id,ca.answers,cr.questions,j.title,j.description
       FROM call_attempts ca
       JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
       JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.erased_at IS NULL
       WHERE ca.tenant_id=$1 AND ca.id=$2 AND ca.status='COMPLETED'`,
      [tenantId, attemptId],
    );
    if (!row?.answers?.length) return;
    const questions = row.questions.map((q) => ({
      ...q,
      key_points: q.key_points ?? [],
    }));
    await this.db.query(
      "UPDATE call_attempts SET assessment_status='PENDING',updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, attemptId],
    );
    const open = assessedQuestions(questions);
    const answered = open.filter((q) =>
      row.answers!.some(
        (a) => a.question_id === q.id && a.answered && a.answer,
      ),
    );
    try {
      let reply: unknown = {};
      let source: { provider_label: string | null; model: string | null } = {
        provider_label: null,
        model: null,
      };
      const skipped: { provider: string; reason: string }[] = [];
      // Nothing for a model to judge: HireAI's own checks are the assessment.
      if (answered.length) {
        let done = false;
        for (const connection of await this.ai.screeningConnections(tenantId)) {
          try {
            const result = await connection.json({
              system: callAssessmentSystemPrompt,
              prompt: callAssessmentPrompt(
                row,
                open.map((question) => ({
                  question,
                  answer: row.answers!.find(
                    (a) => a.question_id === question.id,
                  ),
                })),
              ),
              schema: callAssessmentJsonSchema,
              schemaName: 'call_assessment',
            });
            reply = result.value;
            source = {
              provider_label: aiProviderLabels[connection.provider],
              model: result.model,
            };
            done = true;
            break;
          } catch (error) {
            const reason = failureReason(error);
            skipped.push({ provider: connection.provider, reason });
            if (!PROVIDER_PROBLEMS.has(reason)) throw error;
          }
        }
        if (!done)
          throw new AiProviderError(
            (skipped.at(-1)?.reason as never) ?? 'unavailable',
          );
      }
      const assessment = callAssessment(questions, row.answers, reply, source);
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE call_attempts SET assessment=$3,assessment_status='COMPLETED',assessed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId, attemptId, JSON.stringify(assessment)],
        );
        await audit(
          tx,
          { tenantId, userId: null },
          'call.assessed',
          'call_request',
          row.call_request_id,
          {
            score: assessment.score,
            fit: assessment.fit,
            provider: source.provider_label,
            skipped: skipped.length,
          },
        );
      });
      // A high enough score moves the candidate to interviews (if turned on).
      await this.automation.callAssessed(
        tenantId,
        row.call_request_id,
        assessment,
      );
    } catch (error) {
      const reason = failureReason(error);
      this.logger.warn(`A call assessment failed (${reason})`);
      await this.db.query(
        `UPDATE call_attempts SET assessment=$3,assessment_status='FAILED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, attemptId, JSON.stringify({ failure: reason })],
      );
    }
  }
}
