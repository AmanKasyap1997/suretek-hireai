import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { z } from 'zod';
import { verifyPassword } from '../src/modules/auth';
import { migrationDatabaseUrl } from './database-connection';

export function frontendTenant(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
  key = 'VITE_TENANT_ID',
) {
  const values: Record<string, string> = {};
  for (const name of [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
  ]) {
    const path = resolve(directory, name);
    if (existsSync(path)) Object.assign(values, parse(readFileSync(path)));
  }
  return environment[key] ?? values[key];
}

export async function checkLogin(
  pool: Pool,
  input: { tenantId: string; email: string; password?: string },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      input.tenantId,
    ]);
    const tenant = await client.query('SELECT id FROM tenants WHERE id=$1', [
      input.tenantId,
    ]);
    if (!tenant.rows.length) return 'tenant-missing';
    const users = await client.query<{
      active: boolean;
      password_hash: string;
    }>(
      'SELECT active,password_hash FROM users WHERE tenant_id=$1 AND lower(email)=$2',
      [input.tenantId, input.email.trim().toLowerCase()],
    );
    const user = users.rows[0];
    if (!user) return 'account-missing';
    if (!user.active) return 'account-disabled';
    if (!input.password) return 'password-unchecked';
    return (await verifyPassword(input.password, user.password_hash))
      ? 'credentials-match'
      : 'password-mismatch';
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

async function main() {
  const organizationSlug =
    process.env.AUTH_CHECK_ORGANIZATION ??
    frontendTenant(
      resolve(process.cwd(), 'web'),
      process.env,
      'VITE_ORGANIZATION_SLUG',
    ) ??
    process.env.BOOTSTRAP_TENANT_SLUG ??
    'platform';
  const email =
    process.env.AUTH_CHECK_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(organizationSlug)) {
    console.error(
      'Set AUTH_CHECK_ORGANIZATION to the organization key used on the login form.',
    );
    process.exitCode = 1;
    return;
  }
  if (!z.email().safeParse(email?.trim()).success) {
    console.error(
      'Set AUTH_CHECK_EMAIL or BOOTSTRAP_ADMIN_EMAIL in root .env.',
    );
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({
    connectionString: migrationDatabaseUrl(),
    connectionTimeoutMillis: 10000,
    ssl:
      process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: true }
        : undefined,
  });
  try {
    const resolved = await pool.query(
      'SELECT resolve_public_tenant($1) AS id',
      [organizationSlug],
    );
    const tenantId = resolved.rows[0]?.id;
    if (!tenantId) {
      console.error(
        'Organization key not found in this database. Use the key from your invitation or platform bootstrap.',
      );
      process.exitCode = 1;
      return;
    }
    const result = await checkLogin(pool, {
      tenantId,
      email: email!,
      password:
        process.env.AUTH_CHECK_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD,
    });
    const messages = {
      'tenant-missing':
        'Tenant not found in the configured database. Check the saved tenant ID and database; do not generate a replacement ID for an existing account.',
      'account-missing':
        'Account not found in this tenant. Check the email and whether bootstrap completed against this database.',
      'account-disabled':
        'Account is inactive. Ask an authorized administrator to reactivate it.',
      'password-unchecked':
        'Account exists and is active. Password was not checked. To check it, temporarily set AUTH_CHECK_PASSWORD in root .env and rerun, then remove it.',
      'password-mismatch':
        'Configured password does not match the saved account. Editing BOOTSTRAP_ADMIN_PASSWORD and rerunning bootstrap does not reset an existing password.',
      'credentials-match':
        'Tenant, account and configured password match. Use that email/password, restart Vite, and confirm the API points to the same database checked here.',
    };
    console.log(messages[result]);
    if (!['credentials-match', 'password-unchecked'].includes(result))
      process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module)
  main().catch(() => {
    console.error(
      'Unable to check login. Verify DATABASE_MIGRATION_URL, database availability and applied migrations. Connection details are intentionally omitted.',
    );
    process.exitCode = 1;
  });
