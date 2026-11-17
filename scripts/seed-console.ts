import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { Role } from '../src/shared/enums';
import { scryptSync, randomBytes, randomUUID } from 'node:crypto';
async function main() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new Error('Seed requires explicit development or test environment');
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url || !/(_test|_dev)$/.test(new URL(url).pathname))
    throw new Error('Seed requires an explicitly named _test or _dev database');
  const password = z.string().min(12).max(128).parse(process.env.SEED_PASSWORD),
    tenant = z.uuid().parse(process.env.SEED_TENANT_ID);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await client.query(
      "INSERT INTO tenants(id,name,slug) VALUES($1,'Console test tenant','console-test') ON CONFLICT(id) DO NOTHING",
      [tenant],
    );
    for (const role of Object.values(Role)) {
      const salt = randomBytes(16).toString('hex'),
        hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
      await client.query(
        'INSERT INTO users(id,tenant_id,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,lower(email)) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=true',
        [
          randomUUID(),
          tenant,
          `${role.toLowerCase()}@console.test`,
          hash,
          `Test ${role}`,
          role,
        ],
      );
    }
    await client.query('COMMIT');
    console.log('Console test users seeded');
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error('Console seed failed; check dev/test configuration');
  process.exitCode = 1;
});
