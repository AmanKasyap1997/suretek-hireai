import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DbClient, DbService } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor } from '../../shared/actor';
import { decryptSecret } from '../super-admin/secrets';
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
  /** AI calling is on: recruiters prepare each job's call questions. */
  callingEnabled: boolean;
}

export const aiSettingsSchema = z
  .object({
    screeningProvider: z.enum(aiProviders).nullable(),
    screeningFallback: z.boolean(),
  })
  .strict();
export type ScreeningSettingsInput = z.infer<typeof aiSettingsSchema>;

export const aiCallingSchema = z.object({ enabled: z.boolean() }).strict();

export async function aiSettings(
  db: DbClient,
  tenantId: string,
): Promise<AiSettings> {
  const row = await db.one<{
    screening_provider: AiProvider | null;
    screening_fallback: boolean;
    calling_enabled: boolean;
  }>(
    'SELECT screening_provider,screening_fallback,calling_enabled FROM organization_ai_settings WHERE tenant_id=$1',
    [tenantId],
  );
  return {
    screeningProvider: row?.screening_provider ?? null,
    screeningFallback: row?.screening_fallback ?? true,
    callingEnabled: row?.calling_enabled ?? false,
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

  /** Turns AI calling on or off; the screening choice is unchanged. */
  async updateCalling(actor: Actor, enabled: boolean) {
    await this.db.transaction(async (tx) => {
      const previous = (await aiSettings(tx, actor.tenantId)).callingEnabled;
      await tx.query(
        `INSERT INTO organization_ai_settings(tenant_id,calling_enabled,updated_by)
         VALUES($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET calling_enabled=EXCLUDED.calling_enabled,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [actor.tenantId, enabled, actor.userId],
      );
      await audit(
        tx,
        actor,
        'organization.ai_calling_updated',
        'organization',
        actor.tenantId,
        { enabled, previous },
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
