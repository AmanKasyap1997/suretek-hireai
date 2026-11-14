import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { assertEnumSnapshotCurrent } from './enum-migrations';

async function main(): Promise<void> {
  await assertEnumSnapshotCurrent();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10000,
    ssl:
      process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: true }
        : undefined,
  });
  const client = await pool.connect();
  try {
    // Session-level lock stays on this connection across migration transactions.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('suretek-hireai-migrations'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = resolve(process.cwd(), 'database/migrations');
    const names = (await readdir(directory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
      .sort();
    if (names.length === 0)
      throw new Error('No migrations found in database/migrations');
    for (const name of names) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(
            `Applied migration ${name} has changed; restore it and add a new migration instead`,
          );
        }
        console.log(`Already applied: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        console.log(`Applied: ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('suretek-hireai-migrations'))")
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
