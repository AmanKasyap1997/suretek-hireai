import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { readConfig } from '../common/config';
import { tenantContext } from './tenant-context';

export interface DbClient {
  query<T extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  one<T extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
}

class TransactionClient implements DbClient {
  constructor(private readonly client: PoolClient) {}
  async query<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }
}

@Injectable()
export class DbService implements DbClient, OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly production: boolean;
  private closePromise?: Promise<void>;
  private readonly logger = new Logger(DbService.name);

  constructor() {
    const config = readConfig();
    this.production = config.NODE_ENV === 'production';
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      ssl:
        config.PGSSLMODE === 'require'
          ? { rejectUnauthorized: true }
          : undefined,
    });
    this.pool.on('error', () =>
      this.logger.error('PostgreSQL pool connection error'),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.assertRuntimeRole();
    } catch (error) {
      try {
        await this.closePool();
      } catch {
        // Preserve the startup failure if closing a broken pool also fails.
      }
      throw error;
    }
  }

  /** RLS must also constrain the runtime role, rather than only API filters. */
  async assertRuntimeRole(): Promise<void> {
    const result = await this.pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns_tenant_tables: boolean;
    }>(
      `SELECT r.rolsuper,r.rolbypassrls,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind IN ('r','p')
             AND (c.relname='tenants' OR EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid=c.oid AND a.attname='tenant_id'
                 AND a.attnum>0 AND NOT a.attisdropped
             ))
             AND (pg_has_role(current_user,c.relowner,'USAGE')
                  OR pg_has_role(current_user,c.relowner,'SET'))
         ) AS owns_tenant_tables
       FROM pg_roles r WHERE r.rolname=current_user`,
    );
    const role = result.rows[0];
    if (!role) throw new Error('Unable to verify PostgreSQL runtime role');
    const reasons = [
      ...(role.rolsuper ? ['superuser'] : []),
      ...(role.rolbypassrls ? ['BYPASSRLS'] : []),
      ...(role.owns_tenant_tables ? ['tenant-table ownership'] : []),
    ];
    if (!reasons.length) return;
    const message = `Unsafe PostgreSQL runtime role (${reasons.join(', ')}). Use a non-owner role without SUPERUSER or BYPASSRLS.`;
    if (this.production) throw new Error(message);
    this.logger.warn(message);
  }

  async query<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const tenantId = tenantContext.getStore()?.tenantId;
    if (!tenantId) return (await this.pool.query<T>(sql, params)).rows;
    return this.withTransaction(
      tenantId,
      async (client) => (await client.query<T>(sql, params)).rows,
    );
  }

  async one<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async transaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    return this.withTransaction(tenantContext.getStore()?.tenantId, (client) =>
      fn(new TransactionClient(client)),
    );
  }

  private async withTransaction<T>(
    tenantId: string | undefined,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let started = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      started = true;
      if (tenantId) {
        // Transaction-local GUC is cleared by COMMIT/ROLLBACK before reuse.
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          tenantId,
        ]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      } else {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private closePool(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.closePool();
  }
}
