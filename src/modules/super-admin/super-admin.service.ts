import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { DbClient, DbService } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor, Role } from '../../shared/actor';
import { hashPassword } from '../auth';
import { decryptSecret, encryptSecret, maskSecret } from './secrets';
import {
  adminSchema,
  editOrganization,
  Filters,
  integrationSchema,
  settingsSchema,
} from './super-admin.schemas';
export const defaultSettings = {
  retention_days: 365,
  calling_start: 9,
  calling_end: 18,
  call_quota: 1000,
  emergency_pause: false,
  password_min_length: 12,
  session_seconds: 3600,
};
export async function requirePlatform(db: DbClient, actor: Actor) {
  if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException();
  const user = await db.one(
    'SELECT u.id FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2 AND u.active AND u.role=$3 AND t.is_platform',
    [actor.userId, actor.tenantId, Role.SUPER_ADMIN],
  );
  if (!user) throw new ForbiddenException('Platform administrator required');
}
export function csvCell(value: unknown) {
  let text =
    typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
@Injectable()
export class SuperAdminService {
  constructor(private readonly db: DbService) {}
  async organizations(actor: Actor, f: Filters) {
    await requirePlatform(this.db, actor);
    const where =
      'tenant_id=$1 AND deleted_at IS NULL AND (name ILIKE $2 OR slug ILIKE $2 OR domain ILIKE $2) AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR plan=$4)';
    const params = [
      actor.tenantId,
      '%' + f.search.replace(/[%_\\]/g, '\\$&') + '%',
      f.status ?? null,
      f.plan ?? null,
    ];
    const data = await this.db.query(
      `SELECT * FROM platform_organizations WHERE ${where} ORDER BY ${f.sort} ${f.direction},id LIMIT $5 OFFSET $6`,
      [...params, f.limit, f.offset],
    );
    for (const row of data) {
      row.id = row.organization_id;
      row.usage = await this.usage(actor, row.organization_id);
    }
    const count = await this.db.one(
      `SELECT count(*)::int AS total FROM platform_organizations WHERE ${where}`,
      params,
    );
    return {
      data,
      pagination: { limit: f.limit, offset: f.offset, total: count!.total },
    };
  }
  private async row(db: DbClient, actor: Actor, id: string, lock = false) {
    const row = await db.one(
      `SELECT * FROM platform_organizations WHERE tenant_id=$1 AND organization_id=$2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Organization not found');
    return row;
  }
  private async usage(actor: Actor, id: string) {
    // IDs come only from the authorized directory. Return aggregates, never records.
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
      const usage = await tx.one(
        `SELECT (SELECT count(*)::int FROM users WHERE tenant_id=$1) AS users,
    (SELECT coalesce(sum(byte_size),0)::float/1048576 FROM candidate_documents WHERE tenant_id=$1) AS storage_mb,
    (SELECT coalesce(sum(duration_seconds),0)::float/60 FROM call_requests WHERE tenant_id=$1 AND created_at>=date_trunc('month',now())) AS call_minutes,
    (SELECT count(*)::int FROM call_requests WHERE tenant_id=$1 AND duration_seconds IS NULL AND created_at>=date_trunc('month',now())) AS unmetered_calls`,
        [id],
      );
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
        actor.tenantId,
      ]);
      return usage;
    });
  }
  async detail(actor: Actor, id: string) {
    await requirePlatform(this.db, actor);
    const row = await this.row(this.db, actor, id);
    const admins = await this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
      const rows = await tx.query(
        "SELECT id,full_name,email,status,last_login_at FROM users WHERE tenant_id=$1 AND role='HR_ADMIN' ORDER BY full_name",
        [id],
      );
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
        actor.tenantId,
      ]);
      return rows;
    });
    return { ...row, id, usage: await this.usage(actor, id), admins };
  }
  async edit(
    actor: Actor,
    id: string,
    input: z.infer<typeof editOrganization>,
  ) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      const row = await this.row(tx, actor, id, true);
      await tx.query(
        `UPDATE platform_organizations SET name=$3,domain=$4,country=$5,timezone=$6,plan=$7,enabled_modules=$8,limits=$9,trial_ends_at=$10,status=$11,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2`,
        [
          actor.tenantId,
          id,
          input.name,
          input.domain,
          input.country,
          input.timezone,
          input.plan,
          JSON.stringify(input.enabled_modules),
          JSON.stringify(input.limits),
          input.trial_ends_at,
          row.status === 'suspended' ? row.status : input.status,
        ],
      );
      await tx.query('SELECT govern_organization($1,$2,$3,$4,$5,$6)', [
        actor.userId,
        id,
        input.name,
        row.status === 'suspended' ? row.status : input.status,
        JSON.stringify(input.enabled_modules),
        null,
      ]);
      await audit(tx, actor, 'organization.edited', 'organization', id);
      if (
        JSON.stringify(row.enabled_modules) !==
        JSON.stringify(input.enabled_modules)
      )
        await audit(
          tx,
          actor,
          'organization.modules_changed',
          'organization',
          id,
          { modules: input.enabled_modules },
        );
      if (JSON.stringify(row.limits) !== JSON.stringify(input.limits))
        await audit(
          tx,
          actor,
          'organization.limits_changed',
          'organization',
          id,
          { limits: input.limits },
        );
      return { id };
    });
  }
  async status(
    actor: Actor,
    id: string,
    status: string,
    reason?: string,
    confirmation?: string,
  ) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      const row = await this.row(tx, actor, id, true);
      const deleting = confirmation !== undefined;
      if (deleting && confirmation !== row.name)
        throw new BadRequestException('Type the exact organization name');
      if (status === 'suspended' && !reason && !deleting)
        throw new BadRequestException('A suspension reason is required');
      const deleted = deleting ? new Date() : null;
      await tx.query(
        `UPDATE platform_organizations SET status=$3,suspended_reason=$4,suspended_at=CASE WHEN $3='suspended' THEN now() ELSE NULL END,deleted_at=$5,updated_at=now() WHERE tenant_id=$1 AND organization_id=$2`,
        [actor.tenantId, id, status, reason ?? null, deleted],
      );
      await tx.query('SELECT govern_organization($1,$2,$3,$4,$5,$6)', [
        actor.userId,
        id,
        row.name,
        status,
        JSON.stringify(row.enabled_modules),
        deleted,
      ]);
      await audit(
        tx,
        actor,
        'organization.' +
          (deleting
            ? 'deleted'
            : status === 'suspended'
              ? 'suspended'
              : 'reactivated'),
        'organization',
        id,
        { reason: reason ?? null },
      );
      return { id };
    });
  }
  async reports(actor: Actor) {
    await requirePlatform(this.db, actor);
    const rows = await this.db.query(
      'SELECT organization_id AS id,name,status,limits,trial_ends_at,created_at FROM platform_organizations WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY name',
      [actor.tenantId],
    );
    for (const row of rows) row.usage = await this.usage(actor, row.id);
    const integrations = await this.db.query(
      'SELECT provider,environment,status,error_count FROM integration_configs WHERE tenant_id=$1 ORDER BY provider',
      [actor.tenantId],
    );
    return { organizations: rows, integrations };
  }
  async dashboard(actor: Actor) {
    const report = await this.reports(actor),
      rows = report.organizations;
    const month = new Date();
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);
    return {
      total_organizations: rows.length,
      trial: rows.filter((r) => r.status === 'trial').length,
      active: rows.filter((r) => r.status === 'active').length,
      suspended: rows.filter((r) => r.status === 'suspended').length,
      total_users: rows.reduce((n, r) => n + r.usage.users, 0),
      new_this_month: rows.filter((r) => new Date(r.created_at) >= month)
        .length,
      integrations_ok: report.integrations.filter((r) =>
        ['ok', 'enabled'].includes(r.status),
      ).length,
      integrations_failing: report.integrations.filter(
        (r) => r.status === 'failing',
      ).length,
      attention: rows.filter(
        (r) =>
          r.usage.users >= r.limits.max_users * 0.9 ||
          (r.usage.storage_mb > 0 &&
            r.usage.storage_mb >= r.limits.storage_mb * 0.9) ||
          (r.usage.call_minutes > 0 &&
            r.usage.call_minutes >= r.limits.call_minutes_per_month * 0.9) ||
          (r.status === 'trial' &&
            r.trial_ends_at &&
            new Date(r.trial_ends_at).getTime() < Date.now() + 7 * 86400000),
      ),
      recent_events: (
        await this.logs(actor, {
          limit: 10,
          offset: 0,
          search: '',
          sort: 'created_at',
          direction: 'desc',
        })
      ).data,
    };
  }
  async logs(actor: Actor, f: Filters) {
    await requirePlatform(this.db, actor);
    const where =
      "tenant_id=$1 AND ($2::text IS NULL OR action=$2) AND ($3::uuid IS NULL OR (entity_type='organization' AND entity_id=$3) OR metadata->>'organization_id'=$3::text OR (entity_type='integration' AND entity_id IN (SELECT id FROM integration_configs WHERE tenant_id=$1 AND organization_id=$3))) AND ($4::timestamptz IS NULL OR created_at>=$4) AND ($5::timestamptz IS NULL OR created_at<=$5)";
    const params = [
      actor.tenantId,
      f.action ?? null,
      f.organization_id ?? null,
      f.from ?? null,
      f.to ?? null,
    ];
    const data = await this.db.query(
      `SELECT id,actor_id,action,entity_type,entity_id,metadata,ip,user_agent,created_at FROM audit_events WHERE ${where} ORDER BY created_at DESC,id LIMIT $6 OFFSET $7`,
      [...params, f.limit, f.offset],
    );
    const count = await this.db.one(
      `SELECT count(*)::int AS total FROM audit_events WHERE ${where}`,
      params,
    );
    return {
      data,
      pagination: { limit: f.limit, offset: f.offset, total: count!.total },
    };
  }
  async integrations(actor: Actor) {
    await requirePlatform(this.db, actor);
    return this.db.query(
      'SELECT id,scope,organization_id,provider,environment,status,credential_hint,last_verified_at,error_count FROM integration_configs WHERE tenant_id=$1 ORDER BY provider,environment',
      [actor.tenantId],
    );
  }
  async saveIntegration(
    actor: Actor,
    input: z.infer<typeof integrationSchema>,
  ) {
    await requirePlatform(this.db, actor);
    if (input.organization_id)
      await this.row(this.db, actor, input.organization_id);
    const context = [
      actor.tenantId,
      input.organization_id ?? '',
      input.provider,
      input.environment,
    ].join(':');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,encrypted_credentials,credential_hint,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(tenant_id,provider,environment,(coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,credential_hint=excluded.credential_hint,status='unverified',last_verified_at=NULL,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
        [
          actor.tenantId,
          input.organization_id,
          input.organization_id ? 'organization' : 'platform',
          input.provider,
          input.environment,
          encryptSecret(input.credential, context),
          maskSecret(input.credential),
          actor.userId,
        ],
      );
      // Rotating sandbox credentials invalidates the corresponding production approval.
      if (input.environment === 'sandbox')
        await tx.query(
          "UPDATE integration_configs SET status='unverified' WHERE tenant_id=$1 AND provider=$2 AND organization_id IS NOT DISTINCT FROM $3::uuid AND environment='production'",
          [actor.tenantId, input.provider, input.organization_id],
        );
      await audit(tx, actor, 'integration.saved', 'integration', row!.id, {
        provider: input.provider,
        environment: input.environment,
        organization_id: input.organization_id,
      });
      return row;
    });
  }
  async testIntegration(actor: Actor, id: string) {
    await requirePlatform(this.db, actor);
    const row = await this.db.one(
      'SELECT * FROM integration_configs WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException();
    const fixed: Record<string, string> = {
      openai: 'https://api.openai.com/v1/models',
      google_calendar:
        'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      microsoft_calendar:
        'https://graph.microsoft.com/v1.0/me/calendars?$top=1',
    };
    // Custom providers require an operator-owned HTTPS verification endpoint, never a user URL.
    const endpoint =
      fixed[row.provider] ??
      process.env[`INTEGRATION_${row.provider.toUpperCase()}_VERIFY_URL`];
    if (!endpoint || !endpoint.startsWith('https://'))
      throw new BadRequestException(
        'Operator must configure this provider verification endpoint',
      );
    const credential = decryptSecret(
      row.encrypted_credentials,
      [
        actor.tenantId,
        row.organization_id ?? '',
        row.provider,
        row.environment,
      ].join(':'),
    );
    let ok = false;
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${credential}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      ok = response.ok;
      await response.body?.cancel();
    } catch {
      /* Provider errors may contain secrets. */
    }
    await this.db.transaction(async (tx) => {
      // Use the same lock order as rotation and enable. A failed sandbox test
      // must revoke production approval even when enable is concurrent.
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const updated = await tx.one(
        "UPDATE integration_configs SET status=$3,last_verified_at=CASE WHEN $3='ok' THEN now() ELSE NULL END,error_count=error_count+$4 WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$5 RETURNING id",
        [
          actor.tenantId,
          id,
          ok ? 'ok' : 'failing',
          ok ? 0 : 1,
          row.encrypted_credentials,
        ],
      );
      if (!updated)
        throw new ConflictException('Credentials changed; test again');
      if (!ok && row.environment === 'sandbox')
        await tx.query(
          "UPDATE integration_configs SET status='unverified' WHERE tenant_id=$1 AND provider=$2 AND organization_id IS NOT DISTINCT FROM $3::uuid AND environment='production'",
          [actor.tenantId, row.provider, row.organization_id],
        );
      await audit(tx, actor, 'integration.tested', 'integration', id, {
        ok,
        organization_id: row.organization_id,
      });
    });
    return { ok };
  }
  async enableIntegration(actor: Actor, id: string) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      // Serialize enables with credential rotation (including the sandbox row).
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        'SELECT * FROM integration_configs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException();
      if (!['ok', 'enabled'].includes(row.status))
        throw new ConflictException('Test this connection successfully first');
      if (row.environment === 'production') {
        const sandbox = await tx.one(
          "SELECT id FROM integration_configs WHERE tenant_id=$1 AND provider=$2 AND organization_id IS NOT DISTINCT FROM $3::uuid AND environment='sandbox' AND status IN ('ok','enabled') FOR UPDATE",
          [actor.tenantId, row.provider, row.organization_id],
        );
        if (!sandbox)
          throw new ConflictException(
            'Verify sandbox before enabling production',
          );
      }
      await tx.query(
        "UPDATE integration_configs SET status='enabled' WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, id],
      );
      await audit(tx, actor, 'integration.enabled', 'integration', id, {
        organization_id: row.organization_id,
      });
      return { id };
    });
  }
  async settings(actor: Actor) {
    await requirePlatform(this.db, actor);
    const row = await this.db.one(
      "SELECT value FROM platform_settings WHERE tenant_id=$1 AND key='defaults'",
      [actor.tenantId],
    );
    return {
      defaults: row?.value ?? defaultSettings,
      roles: Object.values(Role),
      role_templates: {
        SUPER_ADMIN: ['Platform governance; no tenant business access'],
        HR_ADMIN: ['Organization staff administration', 'Hiring', 'Core HR'],
        RECRUITER: ['Hiring and recruitment reports'],
        HIRING_MANAGER: ['Assigned jobs, applications and interviews'],
        INTERVIEWER: ['Assigned interviews and scorecards'],
        CANDIDATE: ['Own authenticated profile'],
        EMPLOYEE: ['Own authenticated profile'],
        REPORTING_MANAGER: ['Own authenticated profile'],
        PAYROLL_FINANCE: ['Own authenticated profile'],
        IT_ASSET_ADMIN: ['Own authenticated profile'],
      },
    };
  }
  async saveSettings(actor: Actor, value: z.infer<typeof settingsSchema>) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO platform_settings(tenant_id,key,value,updated_by) VALUES($1,'defaults',$2,$3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()",
        [actor.tenantId, JSON.stringify(value), actor.userId],
      );
      await audit(tx, actor, 'settings.changed', 'settings', null);
      return { saved: true };
    });
  }
  async admins(actor: Actor) {
    await requirePlatform(this.db, actor);
    return this.db.query(
      "SELECT id,full_name,email,status,active,last_login_at FROM users WHERE tenant_id=$1 AND role='SUPER_ADMIN' ORDER BY full_name",
      [actor.tenantId],
    );
  }
  async addAdmin(actor: Actor, input: z.infer<typeof adminSchema>) {
    await requirePlatform(this.db, actor);
    const policy = await this.settings(actor);
    if (input.password.length < policy.defaults.password_min_length)
      throw new BadRequestException('Password is shorter than platform policy');
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const row = await tx.one(
        "INSERT INTO users(tenant_id,email,full_name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,'SUPER_ADMIN',true) RETURNING id",
        [actor.tenantId, input.email, input.fullName, hash],
      );
      await audit(tx, actor, 'role.super_admin_added', 'user', row!.id);
      return row;
    });
  }
  async adminStatus(actor: Actor, id: string, active: boolean) {
    await requirePlatform(this.db, actor);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const row = await tx.one(
        "SELECT id,active FROM users WHERE tenant_id=$1 AND id=$2 AND role='SUPER_ADMIN' FOR UPDATE",
        [actor.tenantId, id],
      );
      if (!row) throw new NotFoundException();
      if (!active && row.active) {
        const count = await tx.one(
          "SELECT count(*)::int AS count FROM users WHERE tenant_id=$1 AND role='SUPER_ADMIN' AND active",
          [actor.tenantId],
        );
        if (count!.count <= 1)
          throw new ConflictException(
            'The last Super Admin cannot be disabled',
          );
      }
      await tx.query(
        'UPDATE users SET active=$3 WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, id, active],
      );
      await audit(tx, actor, 'role.super_admin_status_changed', 'user', id, {
        active,
      });
      return { id };
    });
  }
}
