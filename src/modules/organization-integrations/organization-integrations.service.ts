import { hostedOAuth, oauthFingerprint } from './hosted-oauth';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbClient, DbService } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor, Role } from '../../shared/actor';
import { requirePlatform } from '../super-admin/super-admin.service';
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../super-admin/secrets';
import {
  catalog,
  ConnectionInput,
  credentialFields,
  Provider,
} from './catalog';
import {
  callbackUrl,
  exchange,
  oauthEndpoints,
  verify,
} from './provider-client';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
@Injectable()
export class OrganizationIntegrationsService {
  constructor(private readonly db: DbService) {}
  private async organization(actor: Actor) {
    if (
      actor.role !== Role.HR_ADMIN ||
      !(await this.db.one(
        "SELECT id FROM tenants WHERE id=$1 AND NOT is_platform AND status<>'suspended' AND deleted_at IS NULL",
        [actor.tenantId],
      ))
    )
      throw new ForbiddenException();
  }
  async providers(actor: Actor, platform = false) {
    if (platform) await requirePlatform(this.db, actor);
    else await this.organization(actor);
    const rows = await this.db.query(
      'SELECT provider,enabled,revision FROM integration_providers',
    );
    return catalog
      .map((p) => ({
        ...p,
        hostedOAuth: !!hostedOAuth(p.provider),
        oauthReady: !p.methods.includes('oauth2') || !!hostedOAuth(p.provider),
        platformManaged: p.provider === 'linkedin_jobs',
        setupMessage:
          p.provider === 'linkedin_jobs'
            ? 'LinkedIn partner approval and organization onboarding are required. Contact your platform administrator.'
            : p.methods.includes('oauth2') && !hostedOAuth(p.provider)
              ? 'Your platform administrator must configure the provider application.'
              : null,
        fields: Object.fromEntries(
          p.methods.map((m) => [m, m === 'oauth2' ? [] : credentialFields[m]]),
        ),
        enabled: rows.find((r) => r.provider === p.provider)?.enabled ?? false,
      }))
      .filter((p) => platform || p.enabled);
  }
  async toggle(actor: Actor, provider: Provider, enabled: boolean) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('integration-provider:'||$1))",
        [provider],
      );
      const row = await tx.one(
        `INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled,revision=integration_providers.revision+CASE WHEN integration_providers.enabled<>excluded.enabled THEN 1 ELSE 0 END,updated_by=excluded.updated_by,updated_at=now() RETURNING provider,enabled`,
        [provider, actor.tenantId, enabled, actor.userId],
      );
      await audit(
        tx,
        actor,
        'integration.provider_availability',
        'integration_provider',
        null,
        { provider, enabled },
      );
      return row;
    });
  }
  private async available(tx: DbClient, provider: string, lock = false) {
    if (lock)
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('integration-provider:'||$1))",
        [provider],
      );
    const row = await tx.one(
      'SELECT revision FROM integration_providers WHERE provider=$1 AND enabled=true',
      [provider],
    );
    if (!row)
      throw new ForbiddenException(
        'This integration is disabled by the platform',
      );
    return Number(row.revision);
  }
  private context(actor: Actor, provider: string, environment: string) {
    return ['organization', actor.tenantId, provider, environment].join(':');
  }
  async list(actor: Actor) {
    await this.organization(actor);
    return this.db.query(
      `SELECT c.id,c.provider,c.environment,c.method,c.credential_hint,c.last_verified_at,c.error_count,
   CASE WHEN NOT coalesce(p.enabled,false) THEN 'disabled' WHEN c.provider_revision<>p.revision THEN 'unverified' ELSE c.status END AS status
   FROM integration_configs c LEFT JOIN integration_providers p ON p.provider=c.provider WHERE c.tenant_id=$1 AND c.organization_id=$1 ORDER BY c.provider,c.environment`,
      [actor.tenantId],
    );
  }
  private async save(
    tx: DbClient,
    actor: Actor,
    input: ConnectionInput,
    revision: number,
  ) {
    await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
      actor.tenantId,
    ]);
    const hint = maskSecret(
      input.credentials.apiKey ??
        input.credentials.accessToken ??
        input.credentials.password ??
        input.credentials.clientSecret,
    );
    const row = await tx.one(
      `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,encrypted_credentials,credential_hint,provider_revision,updated_by)
   VALUES($1,$1,'organization',$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(tenant_id,provider,environment,(coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET method=excluded.method,encrypted_credentials=excluded.encrypted_credentials,credential_hint=excluded.credential_hint,provider_revision=excluded.provider_revision,status='unverified',last_verified_at=NULL,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
      [
        actor.tenantId,
        input.provider,
        input.environment,
        input.method,
        encryptSecret(
          JSON.stringify(input.credentials),
          this.context(actor, input.provider, input.environment),
        ),
        hint,
        revision,
        actor.userId,
      ],
    );
    if (input.environment === 'sandbox')
      await this.invalidate(tx, actor, input.provider);
    await audit(tx, actor, 'integration.saved', 'integration', row!.id, {
      provider: input.provider,
      environment: input.environment,
      method: input.method,
    });
    return row;
  }
  private async invalidate(tx: DbClient, actor: Actor, provider: string) {
    await tx.query(
      "UPDATE integration_configs SET status='unverified',last_verified_at=NULL WHERE tenant_id=$1 AND organization_id=$1 AND provider=$2 AND environment='production'",
      [actor.tenantId, provider],
    );
  }
  async connect(actor: Actor, input: ConnectionInput) {
    if (input.provider === 'linkedin_jobs')
      throw new ForbiddenException(
        'LinkedIn Jobs onboarding is managed by the platform',
      );
    await this.organization(actor);
    if (input.method === 'oauth2')
      throw new BadRequestException('Use the OAuth authorization flow');
    return this.db.transaction(async (tx) =>
      this.save(
        tx,
        actor,
        input,
        await this.available(tx, input.provider, true),
      ),
    );
  }
  private async row(actor: Actor, id: string) {
    const row = await this.db.one(
      'SELECT * FROM integration_configs WHERE tenant_id=$1 AND organization_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
  async test(actor: Actor, id: string) {
    await this.organization(actor);
    const row = await this.row(actor, id),
      revision = await this.available(this.db, row.provider);
    if (!row.encrypted_credentials)
      throw new BadRequestException('Reconnect before testing');
    const context = this.context(actor, row.provider, row.environment);
    const credentials = JSON.parse(
      decryptSecret(row.encrypted_credentials, context),
    );
    let result = { ok: false, credentials };
    try {
      result = await verify(row.provider, row.method, credentials);
    } catch {
      /* Never disclose provider responses or credentials. */
    }
    return this.db.transaction(async (tx) => {
      if ((await this.available(tx, row.provider, true)) !== revision)
        throw new ConflictException(
          'Provider availability changed; test again',
        );
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const changed = await tx.one(
        `UPDATE integration_configs SET status=$3,last_verified_at=CASE WHEN $3='ok' THEN now() ELSE NULL END,error_count=error_count+$4,provider_revision=$5,encrypted_credentials=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$7 RETURNING id`,
        [
          actor.tenantId,
          id,
          result.ok ? 'ok' : 'failing',
          result.ok ? 0 : 1,
          revision,
          encryptSecret(JSON.stringify(result.credentials), context),
          row.encrypted_credentials,
        ],
      );
      if (!changed)
        throw new ConflictException('Credentials changed; test again');
      if (!result.ok && row.environment === 'sandbox')
        await this.invalidate(tx, actor, row.provider);
      await audit(tx, actor, 'integration.tested', 'integration', id, {
        ok: result.ok,
      });
      return { ok: result.ok };
    });
  }
  async enable(actor: Actor, id: string) {
    await this.organization(actor);
    const target = await this.row(actor, id);
    return this.db.transaction(async (tx) => {
      const revision = await this.available(tx, target.provider, true);
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        'SELECT * FROM integration_configs WHERE tenant_id=$1 AND organization_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (
        !row ||
        !['ok', 'enabled'].includes(row.status) ||
        row.provider_revision !== revision
      )
        throw new ConflictException('Test this connection successfully first');
      if (
        row.environment === 'production' &&
        !(await tx.one(
          "SELECT id FROM integration_configs WHERE tenant_id=$1 AND organization_id=$1 AND provider=$2 AND environment='sandbox' AND status IN ('ok','enabled') AND provider_revision=$3",
          [actor.tenantId, row.provider, revision],
        ))
      )
        throw new ConflictException(
          'Verify sandbox before enabling production',
        );
      await tx.query(
        "UPDATE integration_configs SET status='enabled' WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, id],
      );
      await audit(tx, actor, 'integration.enabled', 'integration', id);
      return { id };
    });
  }
  async disconnect(actor: Actor, id: string) {
    await this.organization(actor);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        "UPDATE integration_configs SET status='unverified',last_verified_at=NULL,encrypted_credentials='',credential_hint='Disconnected',updated_at=now() WHERE tenant_id=$1 AND organization_id=$1 AND id=$2 RETURNING provider,environment",
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException();
      if (row.environment === 'sandbox')
        await this.invalidate(tx, actor, row.provider);
      await audit(tx, actor, 'integration.disconnected', 'integration', id);
      return { id };
    });
  }
  async startOAuth(actor: Actor, input: ConnectionInput) {
    await this.organization(actor);
    if (input.method !== 'oauth2' || !(input.provider in oauthEndpoints))
      throw new BadRequestException(
        'OAuth consent is unsupported for this provider',
      );
    const app = hostedOAuth(input.provider);
    const hosted = Object.keys(input.credentials).length === 0;
    if (hosted && !app)
      throw new BadRequestException(
        'Your platform administrator must configure the provider application',
      );
    if (input.provider === 'linkedin' && !hosted)
      throw new BadRequestException('Use the platform LinkedIn application');
    input = {
      ...input,
      credentials: hosted
        ? { ...app!, _hosted: 'true' }
        : { ...input.credentials },
    };
    const endpoint =
      oauthEndpoints[input.provider as keyof typeof oauthEndpoints];
    const state = randomBytes(32).toString('hex'),
      verifier = randomBytes(32).toString('base64url');
    const redirectUri = callbackUrl();
    await this.db.transaction(async (tx) => {
      const revision = await this.available(tx, input.provider, true);
      await tx.query(
        'DELETE FROM integration_oauth_states WHERE tenant_id=$1 AND (user_id=$2 OR expires_at<now())',
        [actor.tenantId, actor.userId],
      );
      await tx.query(
        'INSERT INTO integration_oauth_states(tenant_id,user_id,state_hash,encrypted_payload) VALUES($1,$2,$3,$4)',
        [
          actor.tenantId,
          actor.userId,
          digest(state),
          encryptSecret(
            JSON.stringify({
              input,
              verifier,
              revision,
              redirectUri,
              ...(hosted ? { appFingerprint: oauthFingerprint(app!) } : {}),
            }),
            actor.tenantId + ':' + actor.userId + ':' + state,
          ),
        ],
      );
    });
    const url = new URL(endpoint.authorize);
    const params: Record<string, string> = {
      client_id: input.credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoint.scope,
      state,
    };
    if (endpoint.pkce) {
      params.code_challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url');
      params.code_challenge_method = 'S256';
    }
    if (input.provider === 'google_calendar') {
      params.access_type = 'offline';
      params.prompt = 'consent';
    }
    if (input.provider === 'microsoft_calendar') params.prompt = 'consent';
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return { authorizationUrl: url.toString() };
  }
  async completeOAuth(actor: Actor, state: string, code: string) {
    await this.organization(actor);
    const row = await this.db.one(
      'DELETE FROM integration_oauth_states WHERE tenant_id=$1 AND user_id=$2 AND state_hash=$3 AND expires_at>now() RETURNING encrypted_payload',
      [actor.tenantId, actor.userId, digest(state)],
    );
    if (!row)
      throw new BadRequestException(
        'OAuth request expired or already used; reconnect',
      );
    const payload = JSON.parse(
      decryptSecret(
        row.encrypted_payload,
        actor.tenantId + ':' + actor.userId + ':' + state,
      ),
    );
    const input = payload.input as ConnectionInput;
    if (payload.appFingerprint) {
      const current = hostedOAuth(input.provider);
      if (!current || oauthFingerprint(current) !== payload.appFingerprint)
        throw new ConflictException('Provider application changed; reconnect');
    }
    if ((await this.available(this.db, input.provider)) !== payload.revision)
      throw new ConflictException('Provider availability changed; reconnect');
    try {
      const tokens = await exchange(
        input.provider,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: input.credentials.clientId,
          client_secret: input.credentials.clientSecret,
          redirect_uri: payload.redirectUri,
          ...(oauthEndpoints[input.provider as keyof typeof oauthEndpoints].pkce
            ? { code_verifier: payload.verifier }
            : {}),
        }),
      );
      input.credentials = { ...input.credentials, ...tokens };
      if (input.credentials._hosted === 'true')
        delete input.credentials.clientSecret;
    } catch {
      throw new BadRequestException('Provider authorization failed; reconnect');
    }
    return this.db.transaction(async (tx) => {
      const revision = await this.available(tx, input.provider, true);
      if (revision !== payload.revision)
        throw new ConflictException('Provider availability changed; reconnect');
      return this.save(tx, actor, input, revision);
    });
  }
}
