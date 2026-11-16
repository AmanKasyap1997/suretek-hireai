import 'dotenv/config';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { Role } from '../src/shared/enums';
import { migrationDatabaseUrl } from './database-connection';

const scryptAsync = promisify(scrypt);

async function main(): Promise<void> {
  const connectionString = migrationDatabaseUrl();
  const tenantSlug = process.env.BOOTSTRAP_TENANT_SLUG?.trim();
  if (tenantSlug && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(tenantSlug))
    throw new Error(
      'BOOTSTRAP_TENANT_SLUG must be a lowercase URL slug, 3–63 characters',
    );
  const tenantName = process.env.BOOTSTRAP_TENANT_NAME?.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const suppliedTenantId = process.env.BOOTSTRAP_TENANT_ID?.trim() || undefined;
  if (!tenantName || !email || !fullName || !password) {
    throw new Error(
      'BOOTSTRAP_TENANT_NAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and BOOTSTRAP_ADMIN_PASSWORD are required',
    );
  }
  if (password.length < 12 || password.length > 128)
    throw new Error('Bootstrap password must contain 12–128 characters');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
    throw new Error('Bootstrap admin email is invalid');
  if (tenantName.length > 200 || fullName.length > 200)
    throw new Error('Tenant and admin names must be at most 200 characters');
  if (
    suppliedTenantId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      suppliedTenantId,
    )
  ) {
    throw new Error('BOOTSTRAP_TENANT_ID must be a UUID');
  }
  // A no-ID invocation always creates a new tenant. Keep the printed UUID for
  // subsequent invocations rather than trying to identify tenants by name.
  const tenantId = suppliedTenantId ?? randomUUID();
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    ssl:
      process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: true }
        : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FORCE RLS applies to the owner too. Establish a transaction-local context
    // before reading or inserting any tenant data; do not perform global scans.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('suretek-hireai-bootstrap'))",
    );
    const tenant = await client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = $1',
      [tenantId],
    );
    if (!tenant.rows.length) {
      await client.query(
        'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
        [tenantId, tenantName, tenantSlug ?? null],
      );
    }
    if (tenant.rows.length && tenantSlug)
      await client.query('UPDATE tenants SET slug=$2 WHERE id=$1', [
        tenantId,
        tenantSlug,
      ]);
    const existing = await client.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2',
      [tenantId, email],
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      console.log(
        `Admin email already exists; no changes made. Tenant ID: ${tenantId}`,
      );
      return;
    }
    const salt = randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 64)) as Buffer;
    const passwordHash = `scrypt:${salt}:${hash.toString('hex')}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, tenantId, email, passwordHash, fullName, Role.SUPER_ADMIN],
    );
    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'bootstrap.admin_created', 'user', $2)`,
      [tenantId, userId],
    );
    await client.query('COMMIT');
    console.log(`Tenant ID: ${tenantId}`);
    console.log(`Admin user ID: ${userId}`);
    if (!suppliedTenantId) {
      console.log(
        'Created a new tenant because BOOTSTRAP_TENANT_ID was not supplied. Save the printed tenant ID and supply it for every rerun.',
      );
    }
    console.log(
      'Bootstrap complete. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment after use.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed');
  process.exitCode = 1;
});
