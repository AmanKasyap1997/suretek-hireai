import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { DbService, DbClient } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor, Role } from '../../shared/actor';
import { requirePlatform } from '../super-admin/super-admin.service';
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../super-admin/secrets';
import { effectiveCredentials } from './hosted-oauth';
import { exchange } from './provider-client';
import { linkedinPreviewSchema, linkedinSetupSchema } from './linkedin.schemas';
import {
  sendLinkedIn,
  jobTask,
} from './linkedin-client';
@Injectable()
export class LinkedInService {
  constructor(private readonly db: DbService) {}
  private async organization(actor: Actor) {
    if (actor.role !== Role.HR_ADMIN) throw new ForbiddenException();
    const org = await this.db.one(
      'SELECT is_platform,status,deleted_at,enabled_modules FROM tenants WHERE id=$1',
      [actor.tenantId],
    );
    if (
      !org ||
      org.is_platform ||
      org.deleted_at ||
      org.status === 'suspended' ||
      !org.enabled_modules.includes('hiring')
    )
      throw new ForbiddenException('Organization hiring is unavailable');
  }
  private async availability(tx: DbClient, provider: string) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('integration-provider:'||$1))",
      [provider],
    );
    const p = await tx.one(
      'SELECT revision FROM integration_providers WHERE provider=$1 AND enabled',
      [provider],
    );
    if (!p)
      throw new ForbiddenException('This provider is disabled by the platform');
    if (
      provider === 'linkedin_jobs' &&
      process.env.LINKEDIN_JOBS_APPROVED !== 'true'
    )
      throw new ForbiddenException(
        'LinkedIn Jobs requires approved partner access',
      );
    return p.revision;
  }
  private context(tenant: string, provider: string, environment: string) {
    return ['organization', tenant, provider, environment].join(':');
  }
  private async connection(
    actor: Actor,
    provider: 'linkedin_jobs',
  ) {
    await this.organization(actor);
    return this.db.transaction(async (tx) => {
      const revision = await this.availability(tx, provider);
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        "SELECT *,updated_at::text AS version FROM integration_configs WHERE tenant_id=$1 AND organization_id=$1 AND provider=$2 AND environment='production' AND status='enabled' AND provider_revision=$3 FOR UPDATE",
        [actor.tenantId, provider, revision],
      );
      if (!row || !row.encrypted_credentials)
        throw new ConflictException(
          'Connect, verify and enable the production connection first',
        );
      const context = this.context(actor.tenantId, provider, 'production');
      let credentials: Record<string, string> = JSON.parse(
        decryptSecret(row.encrypted_credentials, context),
      );
      if (
        !credentials.accessToken ||
        Number(credentials.expiresAt ?? 0) <= Date.now() + 60000
      ) {
        const auth = effectiveCredentials(provider, credentials);
        try {
          const tokens = await exchange(
            provider,
            new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: auth.clientId,
              client_secret: auth.clientSecret,
            }),
          );
          credentials = { ...credentials, ...tokens };
          row.encrypted_credentials = encryptSecret(
            JSON.stringify(credentials),
            context,
          );
          await tx.query(
            'UPDATE integration_configs SET encrypted_credentials=$3 WHERE tenant_id=$1 AND id=$2',
            [actor.tenantId, row.id, row.encrypted_credentials],
          );
        } catch {
          throw new ConflictException(
            'LinkedIn authentication failed; reconnect or check partner credentials',
          );
        }
      }
      return { row, credentials, token: credentials.accessToken };
    });
  }
  async setupJobs(
    actor: Actor,
    orgId: string,
    input: z.infer<typeof linkedinSetupSchema>,
  ) {
    await requirePlatform(this.db, actor);
    if (process.env.LINKEDIN_JOBS_APPROVED !== 'true')
      throw new BadRequestException(
        'Configure approved LinkedIn Jobs partner access first',
      );
    return this.db.transaction(async (tx) => {
      const revision = await this.availability(tx, 'linkedin_jobs');
      const org = await tx.one(
        "SELECT organization_id FROM platform_organizations WHERE tenant_id=$1 AND organization_id=$2 AND deleted_at IS NULL AND status<>'suspended'",
        [actor.tenantId, orgId],
      );
      if (!org) throw new NotFoundException();
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [orgId]);
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [orgId]);
      const credentials = {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        companyUrn: input.companyUrn,
      };
      const row = await tx.one(
        `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,encrypted_credentials,credential_hint,provider_revision,updated_by)
    VALUES($1,$1,'organization','linkedin_jobs',$2,'oauth_client_credentials',$3,$4,$5,$6)
    ON CONFLICT(tenant_id,provider,environment,(coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,credential_hint=excluded.credential_hint,provider_revision=excluded.provider_revision,status='unverified',last_verified_at=NULL,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
        [
          orgId,
          input.environment,
          encryptSecret(
            JSON.stringify(credentials),
            this.context(orgId, 'linkedin_jobs', input.environment),
          ),
          maskSecret(input.clientSecret),
          revision,
          actor.userId,
        ],
      );
      if (input.environment === 'sandbox')
        await tx.query(
          "UPDATE integration_configs SET status='unverified',last_verified_at=NULL WHERE tenant_id=$1 AND provider='linkedin_jobs' AND environment='production'",
          [orgId],
        );
      await audit(
        tx,
        { tenantId: orgId, userId: null },
        'integration.partner_configured',
        'integration',
        row!.id,
        { platform_actor_id: actor.userId, provider: 'linkedin_jobs' },
      );
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
        actor.tenantId,
      ]);
      await audit(
        tx,
        actor,
        'integration.partner_configured',
        'organization',
        orgId,
        { environment: input.environment, provider: 'linkedin_jobs' },
      );
      return { id: row!.id };
    });
  }
  async jobs(actor: Actor) {
    await this.organization(actor);
    return this.db.query(
      "SELECT id,title,location FROM jobs WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY created_at DESC LIMIT 100",
      [actor.tenantId],
    );
  }
  async history(actor: Actor) {
    await this.organization(actor);
    return this.db.query(
      "SELECT id,job_id,channel,status,remote_id,remote_url,error_code,created_at FROM integration_publications WHERE tenant_id=$1 AND channel='job_listing' ORDER BY created_at DESC LIMIT 100",
      [actor.tenantId],
    );
  }
  async preview(actor: Actor, input: z.infer<typeof linkedinPreviewSchema>) {
    const c = await this.connection(actor, 'linkedin_jobs');
    const job = await this.db.one(
      "SELECT id,title,description,location,created_at,updated_at,updated_at::text AS version FROM jobs WHERE tenant_id=$1 AND id=$2 AND status='PUBLISHED'",
      [actor.tenantId, input.jobId],
    );
    if (!job) throw new NotFoundException('Published job not found');
    if (!/^urn:li:organization:[0-9]+$/.test(c.credentials.companyUrn ?? ''))
      throw new ConflictException('Partner company mapping is missing');
    const description = String(job.description)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    if (
      description.length < 100 ||
      description.length > 25000 ||
      !job.location.trim()
    )
      throw new BadRequestException(
        'LinkedIn Jobs requires a location and a description between 100 and 25000 characters',
      );
    const request = {
      integrationContext: c.credentials.companyUrn,
      companyApplyUrl: input.applicationUrl,
      externalJobPostingId: actor.tenantId + ':' + job.id,
      jobPostingOperationType: 'CREATE',
      title: job.title,
      description,
      listedAt: new Date(job.created_at).getTime(),
      location: job.location,
      listingType: 'BASIC',
    };
    return this.db.transaction(async (tx) => {
      const row = await tx.one(
        `INSERT INTO integration_publications(tenant_id,job_id,connection_id,channel,payload,job_updated_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          actor.tenantId,
          job.id,
          c.row.id,
          input.channel,
          JSON.stringify({
            request,
            connectionUpdatedAt: c.row.version,
            providerRevision: c.row.provider_revision,
          }),
          job.version,
          actor.userId,
        ],
      );
      await audit(
        tx,
        actor,
        'integration.publication_previewed',
        'integration_publication',
        row!.id,
        { channel: input.channel, job_id: job.id },
      );
      return {
        id: row!.id,
        channel: input.channel,
        jobTitle: job.title,
        request,
      };
    });
  }
  async publish(actor: Actor, id: string) {
    await this.organization(actor);
    const preview = await this.db.one(
      'SELECT *,job_updated_at::text AS job_version FROM integration_publications WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!preview) throw new NotFoundException();
    if (preview.status !== 'DRAFT') return { id, status: preview.status };
    if (preview.channel !== 'job_listing')
      throw new ConflictException(
        'This publication channel is retired',
      );
    const provider = 'linkedin_jobs',
      c = await this.connection(actor, provider);
    const claimed = await this.db.transaction(async (tx) => {
      const revision = await this.availability(tx, provider);
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        "SELECT id FROM integration_configs WHERE tenant_id=$1 AND id=$2 AND status='enabled' AND provider_revision=$3 AND updated_at=$4 AND encrypted_credentials=$5 FOR UPDATE",
        [
          actor.tenantId,
          c.row.id,
          revision,
          preview.payload.connectionUpdatedAt,
          c.row.encrypted_credentials,
        ],
      );
      const job = await tx.one(
        "SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 AND status='PUBLISHED' AND updated_at=$3 FOR SHARE",
        [actor.tenantId, preview.job_id, preview.job_version],
      );
      if (
        !row ||
        !job ||
        revision !== preview.payload.providerRevision ||
        Date.now() - new Date(preview.created_at).getTime() > 600000
      )
        throw new ConflictException(
          'Job, connection or provider changed, or preview expired. Preview again.',
        );
      const changed = await tx.one(
        "UPDATE integration_publications SET status='SENDING',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='DRAFT' RETURNING id",
        [actor.tenantId, id],
      );
      if (changed)
        await audit(
          tx,
          actor,
          'integration.publication_requested',
          'integration_publication',
          id,
          { channel: preview.channel, job_id: preview.job_id },
        );
      return !!changed;
    });
    if (!claimed)
      return {
        id,
        status: (await this.db.one(
          'SELECT status FROM integration_publications WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, id],
        ))!.status,
      };
    let result: {
      status: string;
      remoteId: string | null;
      errorCode: string | null;
    } = {
      status: 'UNKNOWN',
      remoteId: null,
      errorCode: 'DELIVERY_UNCONFIRMED',
    };
    try {
      result = await sendLinkedIn(
        c.token,
        preview.payload.request,
      );
    } catch {
      /* Never retry ambiguous external writes automatically or expose provider errors. */
    }
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE integration_publications SET status=$3,remote_id=$4,remote_url=$5,error_code=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [
          actor.tenantId,
          id,
          result.status,
          result.remoteId,
          null,
          result.errorCode,
        ],
      );
      await audit(
        tx,
        actor,
        'integration.publication_result',
        'integration_publication',
        id,
        { status: result.status },
      );
    });
    return { id, status: result.status };
  }
  async refresh(actor: Actor, id: string) {
    await this.organization(actor);
    const row = await this.db.one(
      'SELECT channel,status,remote_id FROM integration_publications WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException();
    if (
      row.channel !== 'job_listing' ||
      !['SUBMITTED', 'PROCESSED'].includes(row.status) ||
      !row.remote_id
    )
      return { id, status: row.status };
    const c = await this.connection(actor, 'linkedin_jobs');
    let result;
    try {
      result = await jobTask(c.token, row.remote_id);
    } catch {
      throw new BadRequestException(
        'LinkedIn task status is temporarily unavailable',
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE integration_publications SET status=$3,remote_url=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('SUBMITTED','PROCESSED')",
        [actor.tenantId, id, result.status, result.url],
      );
      await audit(
        tx,
        actor,
        'integration.publication_status',
        'integration_publication',
        id,
        { status: result.status },
      );
    });
    return { id, status: result.status };
  }
}
