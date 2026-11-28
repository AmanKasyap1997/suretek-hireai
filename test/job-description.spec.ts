import {
  BadGatewayException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import * as ai from '../src/modules/organization-integrations/ai-client';
import {
  AiProviderError,
  generateText,
} from '../src/modules/organization-integrations/ai-client';
import { encryptSecret } from '../src/modules/super-admin/secrets';
import {
  JobDescriptionService,
  jobDescriptionPrompt,
  jobDescriptionSchema,
  plainDescription,
} from '../src/modules/talent-acquisition';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';

const request = { system: 'Write job descriptions.', prompt: 'PHP developer' };
const anthropicMessage = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'About the role:\nBuild web apps.' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...overrides,
  });

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.INTEGRATION_OPENAI_MODEL;
  delete process.env.INTEGRATION_ANTHROPIC_MODEL;
  delete process.env.INTEGRATION_GOOGLE_AI_MODEL;
});

describe('AI text client', () => {
  it('calls Claude with the organization key, effort and refusal fallback', async () => {
    const mock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(anthropicMessage());
    await expect(
      generateText('anthropic', 'anthropic-secret', request),
    ).resolves.toEqual({
      text: 'About the role:\nBuild web apps.',
      model: 'claude-opus-5-5',
    });
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    const headers = new Headers(init?.headers);
    // The SDK chooses the header scheme; it must carry the organization key.
    expect(
      [...headers.values()].some((v) => v.includes('anthropic-secret')),
    ).toBe(true);
    expect(headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'claude-opus-5-5',
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      output_config: { effort: 'medium' },
      fallbacks: 'default',
    });
  });

  it('never sends organization keys to an ambient ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test';
    try {
      const mock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(anthropicMessage());
      await generateText('anthropic', 'anthropic-secret', request);
      expect(String(mock.mock.calls[0][0])).toMatch(
        /^https:\/\/api\.anthropic\.com\//,
      );
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it('maps Claude refusals, truncation and rejected keys without leaking responses', async () => {
    const mock = jest.spyOn(globalThis, 'fetch');
    mock.mockResolvedValueOnce(
      anthropicMessage({ stop_reason: 'refusal', content: [] }),
    );
    await expect(
      generateText('anthropic', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'refused' });
    mock.mockResolvedValueOnce(anthropicMessage({ stop_reason: 'max_tokens' }));
    await expect(
      generateText('anthropic', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'incomplete' });
    mock.mockResolvedValueOnce(
      Response.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'bad key-1234' },
        },
        { status: 401 },
      ),
    );
    const error = await generateText('anthropic', 'key-1234', request).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ reason: 'auth' });
    expect(String((error as Error).message)).not.toContain('key-1234');
    mock.mockResolvedValueOnce(
      Response.json(
        {
          type: 'error',
          error: {
            type: 'billing_error',
            message: 'Your credit balance is too low.',
          },
        },
        { status: 402 },
      ),
    );
    await expect(
      generateText('anthropic', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'quota' });
    // Anthropic reports a low credit balance as a 400 invalid_request_error.
    mock.mockResolvedValueOnce(
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
          },
          request_id: 'req_011ChDqCfX1iQf5XEgC7xtLR',
        },
        { status: 400 },
      ),
    );
    await expect(
      generateText('anthropic', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'quota' });
    mock.mockResolvedValueOnce(
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'model: unknown model',
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      generateText('anthropic', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'configuration' });
  });

  it('calls OpenAI chat completions with the configured model', async () => {
    process.env.INTEGRATION_OPENAI_MODEL = 'gpt-test';
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        model: 'gpt-test-2026',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '  Key responsibilities:\n- Ship  ' },
          },
        ],
      }),
    );
    await expect(
      generateText('openai', 'openai-secret', request),
    ).resolves.toEqual({
      text: 'Key responsibilities:\n- Ship',
      model: 'gpt-test-2026',
    });
    expect(mock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer openai-secret',
        }),
      }),
    );
    expect(JSON.parse(String(mock.mock.calls[0][1]?.body))).toMatchObject({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
    });
  });

  it('maps OpenAI failures to safe reasons', async () => {
    const mock = jest.spyOn(globalThis, 'fetch');
    const cases: [Response, string][] = [
      [new Response('{"error":"secret"}', { status: 401 }), 'auth'],
      [new Response('{}', { status: 429 }), 'rate_limit'],
      [
        Response.json(
          { error: { type: 'requests', code: 'rate_limit_exceeded' } },
          { status: 429 },
        ),
        'rate_limit',
      ],
      // OpenAI also uses 429 when the account has no credits left.
      [
        Response.json(
          {
            error: {
              message: 'You have no credits remaining.',
              type: 'insufficient_quota',
              param: null,
              code: 'credit_balance_exhausted',
            },
          },
          { status: 429 },
        ),
        'quota',
      ],
      [new Response('{}', { status: 404 }), 'configuration'],
      [new Response('{}', { status: 500 }), 'unavailable'],
      [
        Response.json({ choices: [{ message: { refusal: 'No.' } }] }),
        'refused',
      ],
      [
        Response.json({
          choices: [{ finish_reason: 'length', message: { content: 'Ab' } }],
        }),
        'incomplete',
      ],
    ];
    for (const [response, reason] of cases) {
      // Brief server errors are retried once, so both attempts fail here.
      if (response.status >= 500) mock.mockResolvedValueOnce(response.clone());
      mock.mockResolvedValueOnce(response);
      await expect(
        generateText('openai', 'key-1234', request),
      ).rejects.toMatchObject({ reason });
    }
    mock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      generateText('openai', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('calls Gemini generateContent with the key in a header, skipping thoughts', async () => {
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        modelVersion: 'gemini-3.5-flash-lite-001',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [
                { text: 'Planning the sections…', thought: true },
                { text: 'About the role:\n' },
                { text: 'Build web apps.' },
              ],
            },
          },
        ],
      }),
    );
    await expect(
      generateText('google_ai', 'google-secret', request),
    ).resolves.toEqual({
      text: 'About the role:\nBuild web apps.',
      model: 'gemini-3.5-flash-lite-001',
    });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    expect(String(url)).not.toContain('google-secret');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({ 'x-goog-api-key': 'google-secret' }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: { maxOutputTokens: 16000 },
    });
    process.env.INTEGRATION_GOOGLE_AI_MODEL = 'models/gemini-3.8-flash';
    mock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: 'Hi' }] } },
        ],
      }),
    );
    await generateText('google_ai', 'google-secret', request);
    expect(String(mock.mock.calls[1][0])).toContain(
      '/models/gemini-3.8-flash:generateContent',
    );
    delete process.env.INTEGRATION_GOOGLE_AI_MODEL;
  });

  it('retries a brief outage once, but never a timeout', async () => {
    const ok = () =>
      Response.json({
        modelVersion: 'gemini-3.5-flash-lite',
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: 'Draft.' }] } },
        ],
      });
    const mock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }),
      )
      .mockResolvedValueOnce(ok());
    await expect(
      generateText('google_ai', 'key-1234', request),
    ).resolves.toMatchObject({ text: 'Draft.' });
    expect(mock).toHaveBeenCalledTimes(2);
    mock.mockClear();
    mock
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
      .mockResolvedValueOnce(ok());
    await expect(
      generateText('google_ai', 'key-1234', request),
    ).rejects.toMatchObject({ reason: 'unavailable', detail: 'timed out' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('says what failed for the server log: codes, never the provider’s text', async () => {
    const mock = jest.spyOn(globalThis, 'fetch');
    const overloaded = () =>
      Response.json(
        {
          error: {
            status: 'UNAVAILABLE',
            message: 'The model is overloaded. Resume text: …',
          },
        },
        { status: 503 },
      );
    mock
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(overloaded());
    const failure = await generateText('google_ai', 'key-1234', request).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      reason: 'unavailable',
      detail: 'HTTP 503 UNAVAILABLE',
    });
    expect(JSON.stringify(failure)).not.toContain('overloaded');
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    mock.mockRejectedValueOnce(reset).mockRejectedValueOnce(reset);
    await expect(
      generateText('openai', 'key-1234', request),
    ).rejects.toMatchObject({
      reason: 'unavailable',
      detail: 'connection failed (ECONNRESET)',
    });
  });

  it('maps Gemini failures, free-tier limits and blocks to safe reasons', async () => {
    const mock = jest.spyOn(globalThis, 'fetch');
    const googleError = (status: number, error: Record<string, unknown>) =>
      Response.json({ error: { code: status, ...error } }, { status });
    const quotaDetails = (quotaId: string) => [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId }],
      },
    ];
    const cases: [Response, string][] = [
      [
        googleError(400, {
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
            },
          ],
        }),
        'auth',
      ],
      [googleError(403, { status: 'PERMISSION_DENIED' }), 'auth'],
      [
        googleError(429, {
          status: 'RESOURCE_EXHAUSTED',
          details: quotaDetails(
            'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          ),
        }),
        'rate_limit',
      ],
      [
        googleError(429, {
          status: 'RESOURCE_EXHAUSTED',
          details: quotaDetails(
            'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          ),
        }),
        'quota',
      ],
      [googleError(400, { status: 'INVALID_ARGUMENT' }), 'configuration'],
      [googleError(404, { status: 'NOT_FOUND' }), 'configuration'],
      [googleError(503, { status: 'UNAVAILABLE' }), 'unavailable'],
      [Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), 'refused'],
      [Response.json({ candidates: [{ finishReason: 'SAFETY' }] }), 'refused'],
      [
        Response.json({
          candidates: [
            {
              finishReason: 'MAX_TOKENS',
              content: { parts: [{ text: 'Ab' }] },
            },
          ],
        }),
        'incomplete',
      ],
      [
        Response.json({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'thinking', thought: true }] },
            },
          ],
        }),
        'incomplete',
      ],
    ];
    for (const [response, reason] of cases) {
      // Brief server errors are retried once, so both attempts fail here.
      if (response.status >= 500) mock.mockResolvedValueOnce(response.clone());
      mock.mockResolvedValueOnce(response);
      await expect(
        generateText('google_ai', 'key-1234', request),
      ).rejects.toMatchObject({ reason });
    }
  });
});

describe('Job description drafting', () => {
  const actor = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: Role.RECRUITER,
  };
  const input = jobDescriptionSchema.parse({
    title: 'Senior PHP Developer',
    department: 'Engineering',
    location: 'Delhi-NCR',
    employmentType: 'FULL_TIME',
    openings: 2,
    salaryMin: 800000,
    salaryMax: 1600000,
    skills: ['PHP', 'Laravel'],
    guidance: 'Mention 4-6 years of experience.',
  });
  let audits: unknown[][];
  let rows: Record<string, string>[];
  let screeningProvider: string | null;
  const service = () => {
    audits = [];
    const db = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('integration_configs')) return rows;
        if (sql.includes('audit_events')) audits.push(params);
        return [];
      }),
      one: jest.fn(async (sql: string) =>
        sql.includes('organization_ai_settings')
          ? screeningProvider
            ? {
                screening_provider: screeningProvider,
                screening_fallback: false,
              }
            : undefined
          : { name: 'Suretek Infosoft' },
      ),
    };
    return {
      db,
      service: new JobDescriptionService(db as unknown as DbService),
    };
  };
  const connection = (
    provider: 'openai' | 'anthropic' | 'google_ai',
    environment = 'sandbox',
  ) => ({
    id: `conn-${provider}`,
    provider,
    environment,
    encrypted_credentials: encryptSecret(
      JSON.stringify({ apiKey: provider + '-key' }),
      ['organization', actor.tenantId, provider, environment].join(':'),
    ),
  });

  beforeAll(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });

  beforeEach(() => {
    screeningProvider = null;
  });

  it('starts drafting on the provider chosen for resume screening', async () => {
    rows = [connection('openai'), connection('anthropic')];
    screeningProvider = 'anthropic';
    const { service: s } = service();
    expect((await s.providers(actor)).map((p) => p.provider)).toEqual([
      'anthropic',
      'openai',
    ]);
  });

  it('lists only enabled connections without exposing credentials', async () => {
    rows = [
      connection('google_ai'),
      connection('anthropic'),
      connection('openai', 'production'),
    ];
    const { db, service: s } = service();
    expect(await s.providers(actor)).toEqual([
      { provider: 'openai', label: 'OpenAI', environment: 'production' },
      { provider: 'anthropic', label: 'Anthropic', environment: 'sandbox' },
      {
        provider: 'google_ai',
        label: 'Google AI Studio',
        environment: 'sandbox',
      },
    ]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("c.status='enabled'");
    expect(sql).toContain('p.revision=c.provider_revision');
    expect(sql).toContain("(c.environment='production') DESC");
    expect(params).toEqual([
      actor.tenantId,
      ['openai', 'anthropic', 'google_ai'],
    ]);
  });

  it('drafts with the requested provider and audits without storing content', async () => {
    rows = [connection('openai'), connection('anthropic')];
    const spy = jest.spyOn(ai, 'generateText').mockResolvedValue({
      text: '## About the role\n**Build** web apps.\n* PHP\n\n\n\nApply now.',
      model: 'claude-opus-5-5',
    });
    const { service: s } = service();
    await expect(
      s.generate(actor, { ...input, provider: 'anthropic' }),
    ).resolves.toEqual({
      description: 'About the role\nBuild web apps.\n- PHP\n\nApply now.',
      provider: 'anthropic',
      environment: 'sandbox',
      model: 'claude-opus-5-5',
    });
    expect(spy).toHaveBeenCalledWith(
      'anthropic',
      'anthropic-key',
      expect.objectContaining({
        prompt: expect.stringContaining('Company: Suretek Infosoft'),
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.arrayContaining([
        'job.ai_description_generated',
        'conn-anthropic',
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain('Build');
    expect(JSON.stringify(audits)).not.toContain('anthropic-key');
  });

  it('rejects drafting when no provider is enabled', async () => {
    rows = [];
    const spy = jest.spyOn(ai, 'generateText');
    const { service: s } = service();
    await expect(s.generate(actor, input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    rows = [connection('openai')];
    await expect(
      s.generate(actor, { ...input, provider: 'anthropic' }),
    ).rejects.toThrow('Anthropic is not enabled');
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires reconnection when stored credentials cannot be decrypted', async () => {
    rows = [{ ...connection('openai'), encrypted_credentials: 'tampered' }];
    const spy = jest.spyOn(ai, 'generateText');
    await expect(service().service.generate(actor, input)).rejects.toThrow(
      'must be reconnected',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps provider failures to actionable errors and audits the failure', async () => {
    rows = [connection('openai')];
    jest
      .spyOn(ai, 'generateText')
      .mockRejectedValueOnce(new AiProviderError('auth'))
      .mockRejectedValueOnce(new AiProviderError('rate_limit'))
      .mockRejectedValueOnce(new AiProviderError('quota'));
    const { service: s } = service();
    const auth = await s.generate(actor, input).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(BadGatewayException);
    expect((auth as Error).message).toContain('OpenAI rejected');
    const limited = await s.generate(actor, input).catch((e: unknown) => e);
    expect((limited as HttpException).getStatus()).toBe(429);
    const quota = await s.generate(actor, input).catch((e: unknown) => e);
    expect((quota as Error).message).toContain(
      'OpenAI account has run out of credits or reached its usage limit',
    );
    expect(audits.map((a) => a[2])).toEqual([
      'job.ai_description_failed',
      'job.ai_description_failed',
      'job.ai_description_failed',
    ]);
    expect(JSON.parse(String(audits[2][5]))).toEqual({
      provider: 'openai',
      environment: 'sandbox',
      reason: 'quota',
    });
  });

  it('builds a factual prompt from the job details', () => {
    const prompt = jobDescriptionPrompt(
      { ...input, currentDescription: 'We build HR software.' },
      'Suretek Infosoft',
    );
    expect(prompt).toContain('Job title: Senior PHP Developer');
    expect(prompt).toContain('Employment type: Full time');
    expect(prompt).toContain('Annual salary range: ₹8,00,000 – ₹16,00,000');
    expect(prompt).toContain('Required skills: PHP, Laravel');
    expect(prompt).toContain(
      '<recruiter_guidance>\nMention 4-6 years of experience.\n</recruiter_guidance>',
    );
    expect(prompt).toContain('<existing_draft>\nWe build HR software.');
    expect(
      jobDescriptionPrompt(
        { ...input, salaryMin: null, salaryMax: null },
        undefined,
      ),
    ).toContain('Annual salary range: Not provided');
  });

  it('validates drafting requests', () => {
    expect(
      jobDescriptionSchema.safeParse({ ...input, salaryMin: 20, salaryMax: 10 })
        .success,
    ).toBe(false);
    expect(
      jobDescriptionSchema.safeParse({ ...input, provider: 'gemini' }).success,
    ).toBe(false);
    expect(
      jobDescriptionSchema.safeParse({ ...input, apiKey: 'x' }).success,
    ).toBe(false);
    expect(plainDescription('# Title\r\n__Bold__ • item')).toBe(
      'Title\nBold • item',
    );
  });
});
