import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AiProviderError } from '../src/modules/organization-integrations/ai-client';
import { OrganizationAiService } from '../src/modules/organization-integrations/organization-ai';
import {
  CallQuestionsService,
  callQuestionDraftSchema,
  callQuestionsPrompt,
  callQuestionsSystemPrompt,
  jobSchema,
  normalizeCallQuestions,
} from '../src/modules/talent-acquisition';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actor = { tenantId, userId: 'recruiter-1', role: Role.RECRUITER };
const job = {
  title: 'Senior PHP Developer',
  department: 'Engineering',
  location: 'Noida',
  description:
    'Build and maintain Laravel services. Night shifts twice a month.',
};
const draft = callQuestionDraftSchema.parse({
  ...job,
  screeningCriteria: [
    { id: 'c1', label: '4+ years of Laravel', must_have: true },
    { id: 'c2', label: 'AWS', must_have: false },
  ],
});
const question = (overrides: Record<string, unknown> = {}) => ({
  text: 'How many years have you worked with Laravel queues?',
  answer_type: 'number',
  expected_answer: 'none',
  criterion_id: 'c1',
  ...overrides,
});

describe('call questions on a job', () => {
  const base = { ...job };
  const valid = {
    id: 'q1',
    text: 'Are you comfortable working night shifts twice a month?',
    answer_type: 'yes_no',
    expected_answer: 'yes',
    criterion_id: null,
  };

  it('saves up to ten questions with the job', () => {
    expect(
      jobSchema.parse({ ...base, callQuestions: [valid] }).callQuestions,
    ).toEqual([valid]);
  });

  it.each([
    [
      'an expected answer on an open question',
      [{ ...valid, answer_type: 'text' }],
    ],
    [
      'more than ten',
      Array.from({ length: 11 }, (_, i) => ({ ...valid, id: `q${i}` })),
    ],
    ['duplicate ids', [valid, { ...valid }]],
    ['an empty question', [{ ...valid, text: ' ' }]],
  ])('refuses %s', (_name, callQuestions) => {
    expect(jobSchema.safeParse({ ...base, callQuestions }).success).toBe(false);
  });
});

describe('drafting call questions', () => {
  it('asks for job-related questions without repeating the apply form', () => {
    expect(callQuestionsSystemPrompt).toContain('Ask only about the job');
    expect(callQuestionsSystemPrompt).toContain('notice period');
    const prompt = callQuestionsPrompt(draft);
    expect(prompt).toContain('- id: c1 | must have | 4+ years of Laravel');
    expect(prompt).toContain('Night shifts twice a month');
  });

  it('keeps usable questions, links known criteria and drops personal ones', () => {
    const questions = normalizeCallQuestions(
      {
        questions: [
          question(),
          question({
            text: 'Are you comfortable working night shifts twice a month?',
            answer_type: 'yes_no',
            expected_answer: 'yes',
            criterion_id: '',
          }),
          question({ text: 'Are you married?', answer_type: 'yes_no' }),
          question({ text: 'How old are you?' }),
          question({
            text: 'Describe a hard bug you fixed.',
            answer_type: 'text',
            expected_answer: 'yes',
            criterion_id: 'unknown',
          }),
          question(),
        ],
      },
      draft.screeningCriteria,
    );
    expect(questions).toEqual([
      {
        id: 'q1',
        text: 'How many years have you worked with Laravel queues?',
        answer_type: 'number',
        expected_answer: null,
        criterion_id: 'c1',
      },
      {
        id: 'q2',
        text: 'Are you comfortable working night shifts twice a month?',
        answer_type: 'yes_no',
        expected_answer: 'yes',
        criterion_id: null,
      },
      {
        id: 'q3',
        text: 'Describe a hard bug you fixed.',
        answer_type: 'text',
        expected_answer: null,
        criterion_id: null,
      },
    ]);
  });

  it('accepts small differences in a model’s reply', () => {
    const questions = normalizeCallQuestions(
      [
        {
          question: 'Can you work from our Noida office five days a week?',
          answer_type: 'Yes/No',
          expected_answer: 'Yes',
          criterion_id: null,
        },
        {
          text: 'How many years have you used Laravel?',
          answer_type: 'numeric',
          expected_answer: null,
        },
        { text: 'Describe your last project.' },
        null,
        { text: 42 },
      ],
      draft.screeningCriteria,
    );
    expect(questions).toEqual([
      {
        id: 'q1',
        text: 'Can you work from our Noida office five days a week?',
        answer_type: 'yes_no',
        expected_answer: 'yes',
        criterion_id: null,
      },
      {
        id: 'q2',
        text: 'How many years have you used Laravel?',
        answer_type: 'number',
        expected_answer: null,
        criterion_id: null,
      },
      {
        id: 'q3',
        text: 'Describe your last project.',
        answer_type: 'text',
        expected_answer: null,
        criterion_id: null,
      },
    ]);
  });

  it('refuses a reply with no usable questions', () => {
    expect(() => normalizeCallQuestions({ questions: [] }, [])).toThrow();
    expect(() => normalizeCallQuestions({ nonsense: true }, [])).toThrow();
  });
});

describe('call questions service', () => {
  let audits: unknown[][];
  const connection = (provider: string, json: jest.Mock) => ({
    id: `conn-${provider}`,
    provider,
    environment: 'sandbox',
    json,
  });
  const setup = (
    callingEnabled: boolean,
    connections: ReturnType<typeof connection>[] = [],
  ) => {
    audits = [];
    const db = {
      one: jest.fn(async () => ({ calling_enabled: callingEnabled })),
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('INSERT INTO audit_events')) audits.push(params);
        if (sql.includes('integration_configs'))
          return connections.map((c) => ({ ...c, encrypted_credentials: 'x' }));
        return [];
      }),
    } as unknown as DbService;
    const ai = {
      contentConnections: jest.fn(async () => connections),
    } as unknown as OrganizationAiService;
    return new CallQuestionsService(db, ai);
  };
  const ok = jest.fn(async () => ({
    value: { questions: [question()] },
    model: 'claude-opus-5-5',
  }));
  const failing = (reason: ConstructorParameters<typeof AiProviderError>[0]) =>
    jest.fn(async () => {
      throw new AiProviderError(reason);
    });

  it('says whether calling is on and AI can draft', async () => {
    const service = setup(true, [connection('openai', ok)]);
    await expect(service.settings(actor)).resolves.toEqual({
      enabled: true,
      ai_available: true,
    });
  });

  it('only drafts when AI calling is on', async () => {
    const service = setup(false, [connection('openai', ok)]);
    await expect(service.generate(actor, draft)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('falls back to the next provider and audits without the questions', async () => {
    const openai = failing('quota');
    const anthropic = jest.fn(async () => ({
      value: { questions: [question()] },
      model: 'claude-opus-5-5',
    }));
    const service = setup(true, [
      connection('openai', openai),
      connection('anthropic', anthropic),
    ]);
    const result = await service.generate(actor, draft);
    expect(result).toMatchObject({
      provider: 'anthropic',
      label: 'Anthropic',
      questions: [{ id: 'q1', criterion_id: 'c1' }],
    });
    expect(audits.map((a) => a[2])).toEqual([
      'job.ai_call_questions_failed',
      'job.ai_call_questions_generated',
    ]);
    expect(JSON.parse(String(audits[1][5]))).toEqual({
      provider: 'anthropic',
      environment: 'sandbox',
      model: 'claude-opus-5-5',
      count: 1,
    });
  });

  it('reports every provider’s problem when none can draft', async () => {
    const service = setup(true, [
      connection('openai', failing('quota')),
      connection('anthropic', failing('auth')),
    ]);
    const attempt = service.generate(actor, draft);
    // Both providers' problems, with the last one's status.
    await expect(attempt).rejects.toMatchObject({ status: 502 });
    await expect(attempt).rejects.toThrow(
      /OpenAI account has run out of credits.*Anthropic rejected/,
    );
  });

  it('uses only the provider the recruiter picked', async () => {
    const openai = jest.fn();
    const google = jest.fn(async () => ({
      value: { questions: [question()] },
      model: 'gemini-3.5-flash-lite',
    }));
    const service = setup(true, [
      connection('openai', openai),
      connection('google_ai', google),
    ]);
    await expect(
      service.generate(actor, { ...draft, provider: 'google_ai' }),
    ).resolves.toMatchObject({ provider: 'google_ai' });
    expect(openai).not.toHaveBeenCalled();
    await expect(
      service.generate(actor, { ...draft, provider: 'anthropic' }),
    ).rejects.toThrow('Anthropic is not enabled for your organization.');
  });

  it('says what went wrong with every provider it tried', async () => {
    const service = setup(true, [
      connection('google_ai', failing('unavailable')),
      connection('openai', failing('quota')),
    ]);
    await expect(service.generate(actor, draft)).rejects.toThrow(
      'Google AI Studio is unavailable right now. Try again shortly. Your organization’s OpenAI account has run out of credits or reached its usage limit. Ask an HR Admin to check billing with OpenAI.',
    );
  });

  it('doesn’t try another provider after a refusal', async () => {
    const anthropic = jest.fn();
    const service = setup(true, [
      connection('openai', failing('refused')),
      connection('anthropic', anthropic),
    ]);
    await expect(service.generate(actor, draft)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(anthropic).not.toHaveBeenCalled();
  });
});
