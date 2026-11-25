import Anthropic from '@anthropic-ai/sdk';

export const aiProviders = ['openai', 'anthropic', 'google_ai'] as const;
export type AiProvider = (typeof aiProviders)[number];

/**
 * Why a provider call failed, without the provider's own response text, which
 * can echo credentials or prompt content.
 */
export type AiFailure =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'configuration'
  | 'refused'
  | 'incomplete'
  | 'unavailable';

export class AiProviderError extends Error {
  constructor(readonly reason: AiFailure) {
    super(`AI provider request failed: ${reason}`);
  }
}

export interface TextRequest {
  system: string;
  prompt: string;
}

export interface TextResult {
  text: string;
  model: string;
}

/** A file the model reads alongside the prompt. */
export type AiDocument =
  | { kind: 'pdf'; filename: string; base64: string }
  | { kind: 'text'; filename: string; text: string };

export interface JsonRequest {
  system: string;
  prompt: string;
  document?: AiDocument;
  /**
   * JSON schema of the reply. Every object lists all its properties as
   * required and sets additionalProperties to false (OpenAI strict mode).
   */
  schema: Record<string, unknown>;
  schemaName: string;
}

export interface JsonResult {
  value: unknown;
  model: string;
}

const TIMEOUT_MS = 120_000;
/** Server errors that usually clear within seconds, such as "overloaded". */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const RETRY_DELAY_MS = 1000;

/**
 * Fetch with one retry after a brief provider outage: a transient server
 * error or a dropped connection. A timeout is not retried, so a request never
 * waits for two full timeouts. `init` is called per attempt for a fresh
 * timeout signal.
 */
async function fetchWithRetry(
  url: string,
  init: () => RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init());
    } catch (error) {
      // By name: a timeout's DOMException may come from another realm.
      const name = (error as { name?: unknown } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      if (attempt > 0 || timedOut) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    if (attempt > 0 || !TRANSIENT_STATUSES.has(response.status))
      return response;
    // Discard the body without waiting: cancelling can wait on other readers.
    void response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

export function aiModel(provider: AiProvider) {
  if (provider === 'anthropic')
    return process.env.INTEGRATION_ANTHROPIC_MODEL || 'claude-opus-5-5';
  if (provider === 'google_ai')
    // Stable and available on the Gemini API free tier.
    return (
      process.env.INTEGRATION_GOOGLE_AI_MODEL || 'gemini-3.5-flash-lite'
    ).replace(/^models\//, '');
  return process.env.INTEGRATION_OPENAI_MODEL || 'gpt-5';
}

/** The provider's error message, used only to classify; never surfaced. */
function anthropicErrorMessage(error: InstanceType<typeof Anthropic.APIError>) {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === 'string' ? body.error.message : '';
}

async function anthropicMessage(
  apiKey: string,
  system: string,
  content: string | Anthropic.Beta.BetaContentBlockParam[],
  format?: Record<string, unknown>,
): Promise<TextResult> {
  const client = new Anthropic({
    apiKey,
    // Organization keys only go to the provider, never an ambient
    // ANTHROPIC_BASE_URL set on the server for other tooling.
    baseURL: 'https://api.anthropic.com',
    timeout: TIMEOUT_MS,
    maxRetries: 1,
  });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: aiModel('anthropic'),
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content }],
      output_config: {
        effort: 'medium',
        ...(format ? { format: { type: 'json_schema', schema: format } } : {}),
      },
      // On a policy decline the API re-runs the request on the model's
      // server-defined fallback instead of returning an empty refusal.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (error) {
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    )
      throw new AiProviderError('auth');
    if (error instanceof Anthropic.RateLimitError)
      throw new AiProviderError('rate_limit');
    // No credits: 402 billing_error, or a 400 invalid_request_error whose only
    // distinguishing signal is the message ("Your credit balance is too low…").
    if (
      error instanceof Anthropic.APIError &&
      (error.status === 402 ||
        (error.status === 400 &&
          /credit balance/i.test(anthropicErrorMessage(error))))
    )
      throw new AiProviderError('quota');
    if (
      error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.NotFoundError
    )
      throw new AiProviderError('configuration');
    throw new AiProviderError('unavailable');
  }
  if (response.stop_reason === 'refusal') throw new AiProviderError('refused');
  if (response.stop_reason === 'max_tokens')
    throw new AiProviderError('incomplete');
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  if (!text) throw new AiProviderError('incomplete');
  return { text, model: response.model };
}

function anthropicText(apiKey: string, request: TextRequest) {
  return anthropicMessage(apiKey, request.system, request.prompt);
}

async function openaiCompletion(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<TextResult> {
  const model = aiModel('openai');
  let response: Response;
  try {
    response = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      () => ({
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          ...body,
          // Reasoning models count hidden reasoning against this limit.
          max_completion_tokens: 16000,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch {
    throw new AiProviderError('unavailable');
  }
  // Responses are never logged: they can hold candidate or prompt content.
  if (!response.ok) {
    // Only the error type/code is read; the message is never surfaced.
    const failure = (await response.json().catch(() => null)) as {
      error?: { type?: unknown; code?: unknown };
    } | null;
    if (response.status === 401 || response.status === 403)
      throw new AiProviderError('auth');
    // OpenAI uses 429 both for rate limits and for an account without credits.
    if (
      response.status === 429 &&
      [failure?.error?.type, failure?.error?.code].some(
        (value) =>
          value === 'insufficient_quota' ||
          value === 'credit_balance_exhausted',
      )
    )
      throw new AiProviderError('quota');
    if (response.status === 429) throw new AiProviderError('rate_limit');
    if (response.status === 400 || response.status === 404)
      throw new AiProviderError('configuration');
    throw new AiProviderError('unavailable');
  }
  let data: {
    model?: unknown;
    choices?: {
      finish_reason?: unknown;
      message?: { content?: unknown; refusal?: unknown };
    }[];
  };
  try {
    data = await response.json();
  } catch {
    throw new AiProviderError('unavailable');
  }
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  if (typeof choice?.message?.refusal === 'string' && choice.message.refusal)
    throw new AiProviderError('refused');
  if (choice?.finish_reason === 'content_filter')
    throw new AiProviderError('refused');
  if (choice?.finish_reason === 'length')
    throw new AiProviderError('incomplete');
  const text =
    typeof choice?.message?.content === 'string'
      ? choice.message.content.trim()
      : '';
  if (!text) throw new AiProviderError('incomplete');
  return { text, model: typeof data.model === 'string' ? data.model : model };
}

function openaiText(apiKey: string, request: TextRequest) {
  return openaiCompletion(apiKey, {
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
  });
}

type GoogleError = {
  error?: {
    status?: unknown;
    details?: {
      reason?: unknown;
      violations?: { quotaId?: unknown }[];
    }[];
  };
};

const googleBlocked = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

async function googleContent(
  apiKey: string,
  system: string,
  parts: Record<string, unknown>[],
  /** JSON mode, optionally held to a JSON schema. */
  json: false | { schema?: Record<string, unknown> } = false,
): Promise<TextResult> {
  const model = aiModel('google_ai');
  let response: Response;
  try {
    response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      () => ({
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          // Thinking models count their reasoning against this limit.
          generationConfig: {
            maxOutputTokens: 16000,
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(json && json.schema ? { responseJsonSchema: json.schema } : {}),
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch {
    throw new AiProviderError('unavailable');
  }
  if (!response.ok) {
    // Only the status/reason codes are read; the message is never surfaced.
    const failure = (await response
      .json()
      .catch(() => null)) as GoogleError | null;
    const details = failure?.error?.details ?? [];
    if (
      response.status === 401 ||
      response.status === 403 ||
      details.some((d) => d?.reason === 'API_KEY_INVALID')
    )
      throw new AiProviderError('auth');
    if (response.status === 429) {
      // RESOURCE_EXHAUSTED covers both per-minute limits and daily quotas.
      const daily = details.some((d) =>
        d?.violations?.some(
          (v) => typeof v?.quotaId === 'string' && /PerDay/i.test(v.quotaId),
        ),
      );
      throw new AiProviderError(daily ? 'quota' : 'rate_limit');
    }
    if (response.status === 400 || response.status === 404)
      throw new AiProviderError('configuration');
    throw new AiProviderError('unavailable');
  }
  let data: {
    modelVersion?: unknown;
    promptFeedback?: { blockReason?: unknown };
    candidates?: {
      finishReason?: unknown;
      content?: { parts?: { text?: unknown; thought?: unknown }[] };
    }[];
  };
  try {
    data = await response.json();
  } catch {
    throw new AiProviderError('unavailable');
  }
  if (data?.promptFeedback?.blockReason) throw new AiProviderError('refused');
  const candidate = Array.isArray(data?.candidates)
    ? data.candidates[0]
    : undefined;
  const finish = candidate?.finishReason;
  if (typeof finish === 'string' && googleBlocked.has(finish))
    throw new AiProviderError('refused');
  if (finish === 'MAX_TOKENS') throw new AiProviderError('incomplete');
  const text = (candidate?.content?.parts ?? [])
    .flatMap((part) =>
      part?.thought !== true && typeof part?.text === 'string'
        ? [part.text]
        : [],
    )
    .join('')
    .trim();
  if (!text) throw new AiProviderError('incomplete');
  return {
    text,
    model: typeof data.modelVersion === 'string' ? data.modelVersion : model,
  };
}

function googleText(apiKey: string, request: TextRequest) {
  return googleContent(apiKey, request.system, [{ text: request.prompt }]);
}

/** Candidate-supplied text can't close the tag it is wrapped in. */
function textDocument(document: Extract<AiDocument, { kind: 'text' }>) {
  const name = document.filename.replace(/["<>]/g, '');
  return `<document filename="${name}">\n${document.text.replace(/<\/?document\b[^>]*>/gi, '')}\n</document>`;
}

function promptWithText(request: JsonRequest) {
  return request.document?.kind === 'text'
    ? `${textDocument(request.document)}\n\n${request.prompt}`
    : request.prompt;
}

/** The reply as JSON; a reply that isn't JSON counts as incomplete. */
function parseJson(result: TextResult): JsonResult {
  const text = result.text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return { value: JSON.parse(text), model: result.model };
  } catch {
    throw new AiProviderError('incomplete');
  }
}

async function anthropicJson(apiKey: string, request: JsonRequest) {
  const document = request.document;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(document?.kind === 'pdf'
      ? [
          {
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: 'application/pdf' as const,
              data: document.base64,
            },
            title: document.filename,
          },
        ]
      : []),
    { type: 'text', text: promptWithText(request) },
  ];
  return parseJson(
    await anthropicMessage(apiKey, request.system, content, request.schema),
  );
}

async function openaiJson(apiKey: string, request: JsonRequest) {
  const document = request.document;
  return parseJson(
    await openaiCompletion(apiKey, {
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            ...(document?.kind === 'pdf'
              ? [
                  {
                    type: 'file',
                    file: {
                      filename: document.filename,
                      file_data: `data:application/pdf;base64,${document.base64}`,
                    },
                  },
                ]
              : []),
            { type: 'text', text: promptWithText(request) },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.schema,
        },
      },
    }),
  );
}

async function googleJson(apiKey: string, request: JsonRequest) {
  const document = request.document;
  const parts = [
    ...(document?.kind === 'pdf'
      ? [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: document.base64,
            },
          },
        ]
      : []),
    {
      // Also described in words, for the retry without a schema below.
      text: `${promptWithText(request)}\n\nReply with only a JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
    },
  ];
  try {
    // Structured output holds the reply to the schema, as OpenAI and
    // Anthropic do; JSON mode alone lets a model drift from it.
    return parseJson(
      await googleContent(apiKey, request.system, parts, {
        schema: request.schema,
      }),
    );
  } catch (error) {
    // A model that doesn't support response schemas rejects the request.
    if (!(error instanceof AiProviderError && error.reason === 'configuration'))
      throw error;
    return parseJson(await googleContent(apiKey, request.system, parts, {}));
  }
}

/**
 * Ask for a JSON reply matching `request.schema`, reading an optional
 * document. The caller must still validate the value: providers differ in
 * how strictly they follow a schema.
 */
export function generateJson(
  provider: AiProvider,
  apiKey: string,
  request: JsonRequest,
): Promise<JsonResult> {
  if (provider === 'anthropic') return anthropicJson(apiKey, request);
  if (provider === 'google_ai') return googleJson(apiKey, request);
  return openaiJson(apiKey, request);
}

export function generateText(
  provider: AiProvider,
  apiKey: string,
  request: TextRequest,
): Promise<TextResult> {
  if (provider === 'anthropic') return anthropicText(apiKey, request);
  if (provider === 'google_ai') return googleText(apiKey, request);
  return openaiText(apiKey, request);
}
