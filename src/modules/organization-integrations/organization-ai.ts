import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DbClient, DbService } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor } from '../../shared/actor';
import { decryptSecret } from '../super-admin/secrets';
import { plivoConnection } from './plivo';
import {
  AiProvider,
  JsonRequest,
  JsonResult,
  aiProviders,
  generateJson,
} from './ai-client';

export const aiProviderLabels: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google_ai: 'Google AI Studio',
};

export interface AiConnection {
  id: string;
  provider: AiProvider;
  environment: 'production' | 'sandbox';
  encrypted_credentials: string;
}

/**
 * The organization's connected, tested and enabled AI providers, one per
 * provider (production preferred over sandbox), in a fixed preference order.
 */
export async function enabledAiConnections(db: DbClient, tenantId: string) {
  const rows = await db.query<AiConnection>(
    `SELECT DISTINCT ON (c.provider) c.id,c.provider,c.environment,c.encrypted_credentials
     FROM integration_configs c
     JOIN integration_providers p ON p.provider=c.provider AND p.enabled AND p.revision=c.provider_revision
     WHERE c.tenant_id=$1 AND c.organization_id=$1 AND c.provider=ANY($2)
       AND c.method='api_key' AND c.status='enabled' AND c.encrypted_credentials<>''
     ORDER BY c.provider,(c.environment='production') DESC`,
    [tenantId, [...aiProviders]],
  );
  return rows.sort(
    (a, b) => aiProviders.indexOf(a.provider) - aiProviders.indexOf(b.provider),
  );
}

/** The connection's API key, or null when it can't be decrypted. */
export function aiConnectionKey(tenantId: string, connection: AiConnection) {
  try {
    const apiKey: unknown = JSON.parse(
      decryptSecret(
        connection.encrypted_credentials,
        [
          'organization',
          tenantId,
          connection.provider,
          connection.environment,
        ].join(':'),
      ),
    ).apiKey;
    return typeof apiKey === 'string' && apiKey ? apiKey : null;
  } catch {
    return null;
  }
}

/** The HR Admin's choice of AI for resume screening. */
export interface AiSettings {
  /** null: automatic, the enabled providers in HireAI's order. */
  screeningProvider: AiProvider | null;
  /** With a chosen provider: may another enabled provider screen instead? */
  screeningFallback: boolean;
  /** AI calling is on: recruiters prepare call questions and call candidates. */
  callingEnabled: boolean;
  /** The voice AI that talks to candidates; null: automatic. */
  callingProvider: CallingProvider | null;
  /** The voice for calls; null: the server's default. */
  callingVoice: string | null;
  /** The name the AI introduces itself with on calls; null: none. */
  callingAssistantName: string | null;
  /** Shortlist at this resume score or more (null: off). */
  autoShortlistScore: number | null;
  /** Call candidates as soon as they're shortlisted automatically. */
  autoCallShortlisted: boolean;
  /** Move to interviews, and book one, at this call score or more (null: off). */
  autoInterviewScore: number | null;
}

/** AI providers with a realtime voice model. */
export const callingProviders = ['openai', 'google_ai'] as const;
export type CallingProvider = (typeof callingProviders)[number];
export const callingProviderLabels: Record<CallingProvider, string> = {
  openai: 'OpenAI Realtime',
  google_ai: 'Gemini Live',
};

/** Voices each voice AI offers, with how they sound. */
export const callingVoices: Record<
  CallingProvider,
  { id: string; label: string }[]
> = {
  google_ai: [
    { id: 'Sulafat', label: 'Sulafat · warm' },
    { id: 'Achird', label: 'Achird · friendly' },
    { id: 'Aoede', label: 'Aoede · breezy' },
    { id: 'Vindemiatrix', label: 'Vindemiatrix · gentle' },
    { id: 'Umbriel', label: 'Umbriel · easy-going' },
    { id: 'Callirrhoe', label: 'Callirrhoe · easy-going' },
    { id: 'Despina', label: 'Despina · smooth' },
    { id: 'Algieba', label: 'Algieba · smooth' },
    { id: 'Achernar', label: 'Achernar · soft' },
    { id: 'Zubenelgenubi', label: 'Zubenelgenubi · casual' },
    { id: 'Puck', label: 'Puck · upbeat' },
    { id: 'Leda', label: 'Leda · youthful' },
    { id: 'Charon', label: 'Charon · informative' },
    { id: 'Schedar', label: 'Schedar · even' },
    { id: 'Gacrux', label: 'Gacrux · mature' },
    { id: 'Kore', label: 'Kore · firm' },
    { id: 'Orus', label: 'Orus · firm' },
    { id: 'Zephyr', label: 'Zephyr · bright' },
  ],
  openai: [
    { id: 'marin', label: 'Marin · most natural' },
    { id: 'cedar', label: 'Cedar · most natural' },
    { id: 'coral', label: 'Coral' },
    { id: 'sage', label: 'Sage' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'ash', label: 'Ash' },
    { id: 'ballad', label: 'Ballad' },
    { id: 'verse', label: 'Verse' },
    { id: 'alloy', label: 'Alloy' },
    { id: 'echo', label: 'Echo' },
  ],
};

/** The chosen voice if the voice AI offers it; otherwise null (its default). */
export function callingVoice(
  provider: CallingProvider,
  voice: string | null | undefined,
) {
  return voice && callingVoices[provider].some((v) => v.id === voice)
    ? voice
    : null;
}

export const aiSettingsSchema = z
  .object({
    screeningProvider: z.enum(aiProviders).nullable(),
    screeningFallback: z.boolean(),
  })
  .strict();
export type ScreeningSettingsInput = z.infer<typeof aiSettingsSchema>;

export const aiCallingSchema = z
  .object({
    enabled: z.boolean(),
    /** Omitted: unchanged. null: automatic. */
    provider: z.enum(callingProviders).nullable().optional(),
    /** Omitted: unchanged. null: the server's default voice. */
    voice: z
      .string()
      .regex(/^[A-Za-z]{2,40}$/)
      .nullable()
      .optional(),
    /**
     * The name the AI introduces itself with, such as "Priya". Omitted:
     * unchanged. null: none (it introduces itself by the organization).
     */
    assistantName: z
      .string()
      .trim()
      .min(1)
      .max(40)
      // A name of up to three words, never instructions: the voice AI says it.
      .regex(
        /^\p{L}[\p{L}\p{M}.'’-]*(?: [\p{L}\p{M}.'’-]+){0,2}$/u,
        'Use a name of up to three words, made of letters, such as “Priya”.',
      )
      .nullable()
      .optional(),
  })
  .strict();
export type AiCallingInput = z.infer<typeof aiCallingSchema>;

const score = z.number().int().min(1).max(100).nullable();
/** The automatic hiring steps (null scores: off). */
export const aiAutomationSchema = z
  .object({
    shortlistScore: score,
    callShortlisted: z.boolean(),
    interviewScore: score,
  })
  .strict();
export type AiAutomationInput = z.infer<typeof aiAutomationSchema>;

/**
 * The voice AIs that may take a call, in order: the chosen one only, or
 * (automatic) every enabled one.
 */
export function callingOrder<T extends { provider: AiProvider }>(
  connections: T[],
  chosen: CallingProvider | null,
): (T & { provider: CallingProvider })[] {
  const voice = connections.filter(
    (c): c is T & { provider: CallingProvider } =>
      (callingProviders as readonly string[]).includes(c.provider),
  );
  return chosen ? voice.filter((c) => c.provider === chosen) : voice;
}

export async function aiSettings(
  db: DbClient,
  tenantId: string,
): Promise<AiSettings> {
  const row = await db.one<{
    screening_provider: AiProvider | null;
    screening_fallback: boolean;
    calling_enabled: boolean;
    calling_provider: CallingProvider | null;
    calling_voice: string | null;
    calling_assistant_name: string | null;
    auto_shortlist_score: number | null;
    auto_call_shortlisted: boolean;
    auto_interview_score: number | null;
  }>(
    `SELECT screening_provider,screening_fallback,calling_enabled,calling_provider,calling_voice,calling_assistant_name,
       auto_shortlist_score,auto_call_shortlisted,auto_interview_score
     FROM organization_ai_settings WHERE tenant_id=$1`,
    [tenantId],
  );
  return {
    screeningProvider: row?.screening_provider ?? null,
    screeningFallback: row?.screening_fallback ?? true,
    callingEnabled: row?.calling_enabled ?? false,
    callingProvider: row?.calling_provider ?? null,
    callingVoice: row?.calling_voice ?? null,
    callingAssistantName: row?.calling_assistant_name ?? null,
    autoShortlistScore: row?.auto_shortlist_score ?? null,
    autoCallShortlisted: row?.auto_call_shortlisted ?? false,
    autoInterviewScore: row?.auto_interview_score ?? null,
  };
}

/**
 * The providers that may screen, in order: the chosen one first and, if
 * fallback is allowed, the other enabled ones after it.
 */
export function screeningOrder<T extends { provider: AiProvider }>(
  connections: T[],
  settings: Pick<AiSettings, 'screeningProvider' | 'screeningFallback'>,
): T[] {
  const chosen = settings.screeningProvider;
  if (!chosen) return connections;
  const first = connections.filter((c) => c.provider === chosen);
  return settings.screeningFallback
    ? [...first, ...connections.filter((c) => c.provider !== chosen)]
    : first;
}

/**
 * No usable AI connection: none is enabled, the chosen one isn't enabled (and
 * fallback is off), or the key must be re-entered.
 */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: 'no_provider' | 'provider_unavailable' | 'reconnect',
    readonly provider?: AiProvider,
  ) {
    super(`AI provider unavailable: ${reason}`);
  }
}

/** A usable connection; the key stays inside this object. */
export interface ReadyAiConnection {
  id: string;
  provider: AiProvider;
  environment: 'production' | 'sandbox';
  json(request: JsonRequest): Promise<JsonResult>;
}

function ready(tenantId: string, connection: AiConnection): ReadyAiConnection {
  const apiKey = aiConnectionKey(tenantId, connection);
  return {
    id: connection.id,
    provider: connection.provider,
    environment: connection.environment,
    json: (request) =>
      apiKey
        ? generateJson(connection.provider, apiKey, request)
        : Promise.reject(
            new AiUnavailableError('reconnect', connection.provider),
          ),
  };
}

/**
 * What AI calling needs and what's missing. Phone calls need everything; a
 * browser test call needs only a voice AI.
 */
export async function callingStatus(
  db: DbClient,
  tenantId: string,
  connections: AiConnection[],
  chosen: CallingProvider | null,
  voiceChoice: string | null = null,
) {
  const phone = await plivoConnection(db, tenantId);
  const voices = callingOrder(connections, chosen);
  const voiceProblem = voices.length
    ? null
    : chosen
      ? `${callingProviderLabels[chosen]} is chosen for calls, but ${aiProviderLabels[chosen]} isn’t enabled in AI providers.`
      : 'Enable OpenAI or Google AI Studio in AI providers so an AI voice can talk to candidates.';
  return {
    voice_providers: callingOrder(connections, null).map((c) => ({
      provider: c.provider,
      label: callingProviderLabels[c.provider],
    })),
    voice: voices[0]
      ? {
          provider: voices[0].provider,
          label: callingProviderLabels[voices[0].provider],
          // The voice it speaks with, and the others it offers.
          name: callingVoice(voices[0].provider, voiceChoice),
          voices: callingVoices[voices[0].provider],
        }
      : null,
    phone: phone
      ? {
          provider: 'plivo' as const,
          environment: phone.environment,
          number: phone.credentials?.phoneNumber ?? null,
        }
      : null,
    voice_problem: voiceProblem,
    problems: [
      process.env.CALL_PLANNING_ENABLED !== 'true'
        ? 'Calls are turned off on this server. The deployment operator must set CALL_PLANNING_ENABLED=true.'
        : null,
      !phone
        ? 'Connect, test and enable Plivo (Communication) so HireAI can phone candidates.'
        : !phone.credentials
          ? 'Reconnect Plivo: its saved credentials can’t be read.'
          : null,
      voiceProblem,
      !process.env.PUBLIC_API_BASE_URL
        ? 'HireAI’s public address for phone calls isn’t set. The deployment operator must set PUBLIC_API_BASE_URL.'
        : null,
    ].filter((p): p is string => !!p),
  };
}

/** The organization's AI providers and its choice of which one screens resumes. */
@Injectable()
export class OrganizationAiService {
  constructor(private readonly db: DbService) {}

  /**
   * The connections that may screen a resume, in the order to try them. A
   * connection whose key can't be decrypted fails when called, so the next
   * one (if allowed) is tried.
   */
  async screeningConnections(tenantId: string): Promise<ReadyAiConnection[]> {
    const rows = await enabledAiConnections(this.db, tenantId);
    if (!rows.length) throw new AiUnavailableError('no_provider');
    const settings = await aiSettings(this.db, tenantId);
    const ordered = screeningOrder(rows, settings);
    if (!ordered.length)
      throw new AiUnavailableError(
        'provider_unavailable',
        settings.screeningProvider!,
      );
    return ordered.map((connection) => ready(tenantId, connection));
  }

  /**
   * For drafting job content, which carries no candidate data: the provider
   * chosen for screening first, then every other enabled provider.
   */
  async contentConnections(tenantId: string): Promise<ReadyAiConnection[]> {
    const rows = await enabledAiConnections(this.db, tenantId);
    if (!rows.length) throw new AiUnavailableError('no_provider');
    const settings = await aiSettings(this.db, tenantId);
    return screeningOrder(rows, { ...settings, screeningFallback: true }).map(
      (connection) => ready(tenantId, connection),
    );
  }

  /** What the Integrations page shows. */
  async settingsView(tenantId: string) {
    const rows = await enabledAiConnections(this.db, tenantId);
    const settings = await aiSettings(this.db, tenantId);
    const chosen = settings.screeningProvider;
    const missing = !!chosen && !rows.some((c) => c.provider === chosen);
    return {
      screening_provider: chosen,
      screening_fallback: settings.screeningFallback,
      calling_enabled: settings.callingEnabled,
      calling_provider: settings.callingProvider,
      calling_voice: settings.callingVoice,
      calling_assistant_name: settings.callingAssistantName,
      automation: {
        shortlist_score: settings.autoShortlistScore,
        call_shortlisted: settings.autoCallShortlisted,
        interview_score: settings.autoInterviewScore,
      },
      calling: await callingStatus(
        this.db,
        tenantId,
        rows,
        settings.callingProvider,
        settings.callingVoice,
      ),
      providers: rows.map((c) => ({
        provider: c.provider,
        label: aiProviderLabels[c.provider],
        environment: c.environment,
      })),
      problem:
        missing && rows.length
          ? `${aiProviderLabels[chosen]} is chosen for resume screening but isn’t enabled. ${
              settings.screeningFallback
                ? 'Other enabled providers screen resumes until you enable it or choose another.'
                : 'Resumes aren’t screened until you enable it or choose another provider.'
            }`
          : null,
    };
  }

  /** Turns AI calling on or off and picks its voice AI. */
  async updateCalling(actor: Actor, input: AiCallingInput) {
    await this.db.transaction(async (tx) => {
      const previous = await aiSettings(tx, actor.tenantId);
      const provider =
        input.provider === undefined
          ? previous.callingProvider
          : input.provider;
      const voice =
        input.voice === undefined ? previous.callingVoice : input.voice;
      const assistantName =
        input.assistantName === undefined
          ? previous.callingAssistantName
          : input.assistantName;
      if (
        voice &&
        !callingProviders.some((p) =>
          callingVoices[p].some((v) => v.id === voice),
        )
      )
        throw new ConflictException('Choose one of the listed voices.');
      if (
        provider &&
        provider !== previous.callingProvider &&
        !(await enabledAiConnections(tx, actor.tenantId)).some(
          (c) => c.provider === provider,
        )
      )
        throw new ConflictException(
          `${aiProviderLabels[provider]} isn’t enabled. Connect, test and enable it before choosing it for calls.`,
        );
      await tx.query(
        `INSERT INTO organization_ai_settings(tenant_id,calling_enabled,calling_provider,calling_voice,calling_assistant_name,updated_by)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id) DO UPDATE SET calling_enabled=EXCLUDED.calling_enabled,
           calling_provider=EXCLUDED.calling_provider,calling_voice=EXCLUDED.calling_voice,
           calling_assistant_name=EXCLUDED.calling_assistant_name,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [
          actor.tenantId,
          input.enabled,
          provider,
          voice,
          assistantName,
          actor.userId,
        ],
      );
      await audit(
        tx,
        actor,
        'organization.ai_calling_updated',
        'organization',
        actor.tenantId,
        {
          enabled: input.enabled,
          previous: previous.callingEnabled,
          provider,
          previousProvider: previous.callingProvider,
          voice,
          assistantName,
        },
      );
    });
    return this.settingsView(actor.tenantId);
  }

  /** Turns the automatic hiring steps on or off, with their scores. */
  async updateAutomation(actor: Actor, input: AiAutomationInput) {
    await this.db.transaction(async (tx) => {
      const previous = await aiSettings(tx, actor.tenantId);
      await tx.query(
        `INSERT INTO organization_ai_settings(tenant_id,auto_shortlist_score,auto_call_shortlisted,auto_interview_score,updated_by)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id) DO UPDATE SET auto_shortlist_score=EXCLUDED.auto_shortlist_score,
           auto_call_shortlisted=EXCLUDED.auto_call_shortlisted,auto_interview_score=EXCLUDED.auto_interview_score,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [
          actor.tenantId,
          input.shortlistScore,
          input.callShortlisted,
          input.interviewScore,
          actor.userId,
        ],
      );
      await audit(
        tx,
        actor,
        'organization.ai_automation_updated',
        'organization',
        actor.tenantId,
        {
          shortlistScore: input.shortlistScore,
          callShortlisted: input.callShortlisted,
          interviewScore: input.interviewScore,
          previous: {
            shortlistScore: previous.autoShortlistScore,
            callShortlisted: previous.autoCallShortlisted,
            interviewScore: previous.autoInterviewScore,
          },
        },
      );
    });
    return this.settingsView(actor.tenantId);
  }

  async updateSettings(actor: Actor, input: ScreeningSettingsInput) {
    const provider = input.screeningProvider;
    // Automatic always moves on to the next provider.
    const fallback = provider ? input.screeningFallback : true;
    await this.db.transaction(async (tx) => {
      if (
        provider &&
        !(await enabledAiConnections(tx, actor.tenantId)).some(
          (c) => c.provider === provider,
        )
      )
        throw new ConflictException(
          `${aiProviderLabels[provider]} isn’t enabled. Connect, test and enable it before choosing it for resume screening.`,
        );
      const previous = await aiSettings(tx, actor.tenantId);
      await tx.query(
        `INSERT INTO organization_ai_settings(tenant_id,screening_provider,screening_fallback,updated_by)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (tenant_id) DO UPDATE SET screening_provider=EXCLUDED.screening_provider,
           screening_fallback=EXCLUDED.screening_fallback,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [actor.tenantId, provider, fallback, actor.userId],
      );
      await audit(
        tx,
        actor,
        'organization.ai_settings_updated',
        'organization',
        actor.tenantId,
        {
          screeningProvider: provider,
          screeningFallback: fallback,
          previous: {
            screeningProvider: previous.screeningProvider,
            screeningFallback: previous.screeningFallback,
          },
        },
      );
    });
    return this.settingsView(actor.tenantId);
  }
}
