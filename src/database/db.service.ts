import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { readConfig } from '../common/config';
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
export class DbService implements DbClient, OnModuleDestroy {
  private readonly pool: Pool;
  constructor() {
    const config = readConfig();
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
      console.error('PostgreSQL pool connection error'),
    );
  }
  async query<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }
  async transaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TransactionClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
