import {
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
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
  generateText,
} from '../../organization-integrations/ai-client';
import {
  aiConnectionKey,
  aiProviderLabels as labels,
  aiSettings,
  enabledAiConnections,
} from '../../organization-integrations/organization-ai';
import { JobDescriptionInput } from './jobs.schemas';

const employment: Record<string, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'Contract',
  INTERN: 'Internship',
};

export const jobDescriptionSystemPrompt = `You are an experienced recruiter who writes clear, accurate and inclusive job descriptions for hiring teams in India.

Format the description as plain text for a plain text editor:
- Do not use Markdown: no #, * or ** characters and no tables.
- Put each section heading on its own line, ending with a colon.
- Put each list item on its own line starting with "- ".
- Use these sections in order: About the role, Key responsibilities, Required skills and qualifications, Nice to have (only when the details support it), What we offer (only when compensation or benefits are provided). End with one sentence inviting candidates to apply.
- Aim for 250 to 450 words.

Accuracy:
- Use only the facts in the job details, the recruiter's guidance and any existing draft. Do not invent company history, products, clients, benefits, perks, figures, certifications or policies. When a detail is missing, write around it in general terms instead of guessing.
- Mention the salary only when it is provided, in Indian rupees per year.
- Use gender-neutral, inclusive language. Do not refer to age, gender, religion, caste, marital status, nationality or other personal characteristics, and avoid exclusionary phrases such as "young" or "native speaker".

The recruiter's guidance may change tone, emphasis or content. When an existing draft is provided, improve and complete it while keeping its facts.

Return only the job description text, with no introduction, notes or commentary.`;

const money = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);

function salaryText(min?: number | null, max?: number | null) {
  if (min != null && max != null) return `${money(min)} – ${money(max)}`;
  if (min != null) return `From ${money(min)}`;
  if (max != null) return `Up to ${money(max)}`;
  return 'Not provided';
}

export function jobDescriptionPrompt(
  input: JobDescriptionInput,
  company: string | undefined,
) {
  const details = [
    `Job title: ${input.title}`,
    ...(company ? [`Company: ${company}`] : []),
    `Department: ${input.department}`,
    `Location: ${input.location}`,
    `Employment type: ${employment[input.employmentType ?? 'FULL_TIME']}`,
    ...(input.openings ? [`Open positions: ${input.openings}`] : []),
    `Annual salary range: ${salaryText(input.salaryMin, input.salaryMax)}`,
    `Required skills: ${input.skills.length ? input.skills.join(', ') : 'Not provided'}`,
  ].join('\n');
  return [
    'Write a job description from these details.',
    `<job_details>\n${details}\n</job_details>`,
    ...(input.guidance
      ? [`<recruiter_guidance>\n${input.guidance}\n</recruiter_guidance>`]
      : []),
    ...(input.currentDescription
      ? [`<existing_draft>\n${input.currentDescription}\n</existing_draft>`]
      : []),
  ].join('\n\n');
}

/** Normalise stray Markdown so the text reads cleanly in a plain textarea. */
export function plainDescription(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function failure(reason: AiFailure, provider: AiProvider): HttpException {
  const name = labels[provider];
  switch (reason) {
    case 'auth':
      return new BadGatewayException(
        `${name} rejected your organization’s credentials. Ask an HR Admin to test the connection in Integrations.`,
      );
    case 'rate_limit':
      return new HttpException(
        `${name} is limiting requests right now. Wait a minute and try again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    case 'quota':
      return new BadGatewayException(
        `Your organization’s ${name} account has run out of credits or reached its usage limit. Ask an HR Admin to check billing and quotas with ${name}, or choose another AI provider.`,
      );
    case 'configuration':
      return new BadGatewayException(
        `${name} could not process the request. The deployment operator should check the configured model.`,
      );
    case 'refused':
      return new UnprocessableEntityException(
        `${name} declined to write this description. Review the job details and guidance, then try again.`,
      );
    case 'incomplete':
      return new BadGatewayException(
        `${name} returned an incomplete description. Try again.`,
      );
    default:
      return new ServiceUnavailableException(
        `${name} is unavailable right now. Try again shortly.`,
      );
  }
}

@Injectable()
export class JobDescriptionService {
  constructor(private readonly db: DbService) {}

  /**
   * Enabled organization connections, preferring production over sandbox.
   * The provider chosen for resume screening comes first, so drafting starts
   * on it too; the others stay available in the picker.
   */
  private async connections(actor: Actor) {
    const rows = await enabledAiConnections(this.db, actor.tenantId);
    const chosen = (await aiSettings(this.db, actor.tenantId))
      .screeningProvider;
    return chosen
      ? [
          ...rows.filter((c) => c.provider === chosen),
          ...rows.filter((c) => c.provider !== chosen),
        ]
      : rows;
  }

  async providers(actor: Actor) {
    return (await this.connections(actor)).map((c) => ({
      provider: c.provider,
      label: labels[c.provider],
      environment: c.environment,
    }));
  }

  async generate(actor: Actor, input: JobDescriptionInput) {
    const available = await this.connections(actor);
    const connection = input.provider
      ? available.find((c) => c.provider === input.provider)
      : available[0];
    if (!connection)
      throw new ConflictException(
        input.provider
          ? `${labels[input.provider]} is not enabled for your organization. An HR Admin must connect, test and enable it in Integrations.`
          : 'No AI provider is enabled for your organization. An HR Admin must connect, test and enable OpenAI or Anthropic in Integrations.',
      );
    const apiKey = aiConnectionKey(actor.tenantId, connection);
    if (!apiKey)
      throw new ConflictException(
        `The ${labels[connection.provider]} connection must be reconnected in Integrations.`,
      );
    const company = (
      await this.db.one<{ name: string }>(
        'SELECT name FROM tenants WHERE id=$1',
        [actor.tenantId],
      )
    )?.name;
    const evidence = {
      provider: connection.provider,
      environment: connection.environment,
    };
    let result: { text: string; model: string };
    try {
      result = await generateText(connection.provider, apiKey, {
        system: jobDescriptionSystemPrompt,
        prompt: jobDescriptionPrompt(input, company),
      });
    } catch (error) {
      const reason: AiFailure =
        error instanceof AiProviderError ? error.reason : 'unavailable';
      await audit(
        this.db,
        actor,
        'job.ai_description_failed',
        'integration',
        connection.id,
        { ...evidence, reason },
      );
      throw failure(reason, connection.provider);
    }
    const description = plainDescription(result.text);
    if (description.length < 10 || description.length > 30_000)
      throw failure('incomplete', connection.provider);
    // Content is not stored: the recruiter reviews it and saves it with the job.
    await audit(
      this.db,
      actor,
      'job.ai_description_generated',
      'integration',
      connection.id,
      { ...evidence, model: result.model },
    );
    return { description, ...evidence, model: result.model };
  }
}
