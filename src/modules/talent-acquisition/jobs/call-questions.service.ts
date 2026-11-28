import {
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { audit } from '../../../platform/audit/audit';
import { Actor } from '../../../shared/actor';
import {
  AiFailure,
  AiProvider,
  AiProviderError,
} from '../../organization-integrations/ai-client';
import {
  AiUnavailableError,
  OrganizationAiService,
  ReadyAiConnection,
  aiProviderLabels,
  aiSettings,
  enabledAiConnections,
} from '../../organization-integrations/organization-ai';
import {
  CallQuestionDraftInput,
  CallQuestionsError,
  callQuestionsJsonSchema,
  callQuestionsPrompt,
  callQuestionsSystemPrompt,
  normalizeCallQuestions,
} from './call-questions';

type Reason = AiFailure | 'reconnect' | 'invalid_output';
/** Problems with one provider, so the next enabled one is tried. */
const providerProblems: ReadonlySet<Reason> = new Set([
  'auth',
  'quota',
  'rate_limit',
  'configuration',
  'unavailable',
  'incomplete',
  'reconnect',
  'invalid_output',
]);

function reasonOf(error: unknown): Reason {
  if (error instanceof AiProviderError) return error.reason;
  if (error instanceof AiUnavailableError) return 'reconnect';
  if (error instanceof CallQuestionsError) return 'invalid_output';
  return 'unavailable';
}

function failure(reason: Reason, provider: AiProvider): HttpException {
  const name = aiProviderLabels[provider];
  switch (reason) {
    case 'auth':
      return new BadGatewayException(
        `${name} rejected your organization’s credentials. Ask an HR Admin to test the connection in Integrations.`,
      );
    case 'reconnect':
      return new ConflictException(
        `The ${name} connection must be reconnected in Integrations.`,
      );
    case 'rate_limit':
      return new HttpException(
        `${name} is limiting requests right now. Wait a minute and try again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    case 'quota':
      return new BadGatewayException(
        `Your organization’s ${name} account has run out of credits or reached its usage limit. Ask an HR Admin to check billing with ${name}.`,
      );
    case 'configuration':
      return new BadGatewayException(
        `${name} could not process the request. The deployment operator should check the configured model.`,
      );
    case 'refused':
      return new UnprocessableEntityException(
        `${name} declined to write these questions. Review the job details and try again.`,
      );
    case 'incomplete':
    case 'invalid_output':
      return new BadGatewayException(
        `${name} returned questions HireAI couldn’t use. Try again.`,
      );
    default:
      return new ServiceUnavailableException(
        `${name} is unavailable right now. Try again shortly.`,
      );
  }
}

/** Drafts the questions a job's AI call asks, for a recruiter to review. */
@Injectable()
export class CallQuestionsService {
  private readonly logger = new Logger('CallQuestions');
  constructor(
    private readonly db: DbService,
    private readonly ai: OrganizationAiService,
  ) {}

  /** Whether the job wizard shows call questions, and whether AI can draft them. */
  async settings(actor: Actor) {
    const settings = await aiSettings(this.db, actor.tenantId);
    return {
      enabled: settings.callingEnabled,
      ai_available:
        (await enabledAiConnections(this.db, actor.tenantId)).length > 0,
    };
  }

  async generate(actor: Actor, input: CallQuestionDraftInput) {
    if (!(await aiSettings(this.db, actor.tenantId)).callingEnabled)
      throw new ConflictException(
        'AI calling is off for your organization. An HR Admin can turn it on in Integrations.',
      );
    let connections: ReadyAiConnection[];
    try {
      connections = await this.ai.contentConnections(actor.tenantId);
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      throw new ConflictException(
        'No AI provider is enabled for your organization. An HR Admin must connect, test and enable OpenAI, Anthropic or Google AI Studio in Integrations.',
      );
    }
    // A provider the recruiter picked is the only one used.
    if (input.provider) {
      connections = connections.filter((c) => c.provider === input.provider);
      if (!connections.length)
        throw new ConflictException(
          `${aiProviderLabels[input.provider]} is not enabled for your organization. An HR Admin must connect, test and enable it in Integrations.`,
        );
    }
    const request = {
      system: callQuestionsSystemPrompt,
      prompt: callQuestionsPrompt(input),
      schema: callQuestionsJsonSchema,
      schemaName: 'call_questions',
    };
    const failed: { reason: Reason; connection: ReadyAiConnection }[] = [];
    for (const connection of connections) {
      const evidence = {
        provider: connection.provider,
        environment: connection.environment,
      };
      try {
        const reply = await connection.json(request);
        const questions = normalizeCallQuestions(
          reply.value,
          input.screeningCriteria,
        );
        // The questions aren't stored: the recruiter saves them with the job.
        await audit(
          this.db,
          actor,
          'job.ai_call_questions_generated',
          'integration',
          connection.id,
          { ...evidence, model: reply.model, count: questions.length },
        );
        return {
          questions,
          ...evidence,
          label: aiProviderLabels[connection.provider],
          model: reply.model,
        };
      } catch (error) {
        const reason = reasonOf(error);
        if (error instanceof CallQuestionsError)
          this.logger.warn(
            `Call questions reply from ${connection.provider} unusable: ${error.detail}`,
          );
        await audit(
          this.db,
          actor,
          'job.ai_call_questions_failed',
          'integration',
          connection.id,
          { ...evidence, reason },
        );
        failed.push({ reason, connection });
        if (!providerProblems.has(reason)) break;
      }
    }
    // Every provider tried, each with what went wrong, not only the last.
    const errors = failed.map((attempt) =>
      failure(attempt.reason, attempt.connection.provider),
    );
    if (errors.length === 1) throw errors[0];
    throw new HttpException(
      errors.map((error) => error.message).join(' '),
      errors.at(-1)!.getStatus(),
    );
  }
}
