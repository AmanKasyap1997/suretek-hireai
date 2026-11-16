import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { DbService } from '../src/database/db.service';
import { runWithTenant } from '../src/database/tenant-context';
import {
  ApplicationStage,
  CallLanguage,
  ConsentScope,
  JobStatus,
  LeaveType,
  OfferStatus,
  Role,
} from '../src/common/enums';

interface TenantFixture {
  tenantId: string;
  userId: string;
  candidateId: string;
  consentId: string;
  auditId: string;
}

interface TenantTable {
  name: string;
  row_security: boolean;
  force_row_security: boolean;
}

function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function tenantFixture(client: PoolClient): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const candidateId = randomUUID();
  const jobId = randomUUID();
  const applicationId = randomUUID();
  const offerId = randomUUID();
  const employeeId = randomUUID();
  const consentId = randomUUID();
  const auditId = randomUUID();
  await client.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    tenantId,
    `RLS fixture ${tenantId}`,
  ]);
  await client.query(
    `INSERT INTO users(id,tenant_id,email,password_hash,full_name,role)
     VALUES($1,$2,$3,'unused-rls-fixture-hash','RLS User',$4)`,
    [userId, tenantId, `${userId}@example.test`, Role.HR_ADMIN],
  );
  await client.query(
    `INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by)
     VALUES($1,$2,'RLS job','RLS fixture job description','Engineering','Remote',$3,$4)`,
    [jobId, tenantId, JobStatus.PUBLISHED, userId],
  );
  await client.query(
    `INSERT INTO candidates(id,tenant_id,full_name,email) VALUES($1,$2,'RLS Candidate',$3)`,
    [candidateId, tenantId, `${candidateId}@example.test`],
  );
  await client.query(
    `INSERT INTO applications(id,tenant_id,job_id,candidate_id,stage) VALUES($1,$2,$3,$4,$5)`,
    [applicationId, tenantId, jobId, candidateId, ApplicationStage.HIRED],
  );
  await client.query(
    `INSERT INTO offers(id,tenant_id,application_id,status,annual_ctc,currency,joining_date,created_by,approved_by,accepted_at,acceptance_reference)
     VALUES($1,$2,$3,$4,'1000000.00','INR','2026-12-01',$5,$5,now(),'RLS acceptance fixture')`,
    [offerId, tenantId, applicationId, OfferStatus.ACCEPTED, userId],
  );
  await client.query(
    `INSERT INTO employees(id,tenant_id,candidate_id,source_offer_id,employee_code,full_name,email,joining_date,annual_ctc,currency)
     VALUES($1,$2,$3,$4,$5,'RLS Employee',$6,'2026-12-01','1000000.00','INR')`,
    [
      employeeId,
      tenantId,
      candidateId,
      offerId,
      `RLS-${employeeId}`,
      `${employeeId}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO onboarding_tasks(tenant_id,employee_id,title) VALUES($1,$2,'RLS onboarding fixture')`,
    [tenantId, employeeId],
  );
  await client.query(
    `INSERT INTO consents(id,tenant_id,candidate_id,scope,granted,source,captured_by)
     VALUES($1,$2,$3,$4,true,'RLS consent fixture',$5)`,
    [consentId, tenantId, candidateId, ConsentScope.CALL, userId],
  );
  await client.query(
    `INSERT INTO call_requests(tenant_id,application_id,requested_by,language,idempotency_key)
     VALUES($1,$2,$3,$4,$5)`,
    [tenantId, applicationId, userId, CallLanguage.EN, randomUUID()],
  );
  await client.query(
    `INSERT INTO leave_requests(tenant_id,employee_id,type,start_date,end_date,reason,requested_by)
     VALUES($1,$2,$3,'2026-12-10','2026-12-11','RLS leave fixture',$4)`,
    [tenantId, employeeId, LeaveType.ANNUAL, userId],
  );
  await client.query(
    `INSERT INTO attendance(tenant_id,employee_id,work_date,check_in)
     VALUES($1,$2,'2026-12-02','2026-12-02T09:00:00Z')`,
    [tenantId, employeeId],
  );
  await client.query(
    `INSERT INTO audit_events(id,tenant_id,actor_id,action,entity_type,entity_id)
     VALUES($1,$2,$3,'rls.fixture','candidate',$4)`,
    [auditId, tenantId, userId, candidateId],
  );
  return { tenantId, userId, candidateId, consentId, auditId };
}

async function restoreEnvironment(
  changes: Record<string, string>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(changes).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, changes);
  try {
    await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('PostgreSQL row-level isolation with the non-owner runtime role', () => {
  let admin: Pool;
  let db: DbService;
  let first: TenantFixture;
  let second: TenantFixture;
  let tenantTables: TenantTable[];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.TEST_ADMIN_DATABASE_URL) {
      throw new Error(
        'RLS tests require DATABASE_URL for the constrained application role and TEST_ADMIN_DATABASE_URL for fixture administration.',
      );
    }
    process.env.JWT_SECRET ??= 'integration-test-secret-minimum-32-characters';
    admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      first = await tenantFixture(client);
      second = await tenantFixture(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    db = new DbService();
    await db.onModuleInit();
    tenantTables = (
      await admin.query<TenantTable>(
        `SELECT c.relname AS name,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND
         (c.relname='tenants' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped))
       ORDER BY c.relname`,
      )
    ).rows;
  });

  afterAll(async () => {
    if (admin && first && second) {
      for (const table of [
        'audit_events',
        'attendance',
        'leave_requests',
        'call_requests',
        'consents',
        'onboarding_tasks',
        'employees',
        'offers',
        'applications',
        'candidates',
        'jobs',
        'users',
      ]) {
        await admin.query(
          `DELETE FROM ${identifier(table)} WHERE tenant_id=ANY($1::uuid[])`,
          [[first.tenantId, second.tenantId]],
        );
      }
      await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [
        [first.tenantId, second.tenantId],
      ]);
    }
    if (db) await db.onModuleDestroy();
    if (admin) await admin.end();
  });

  it('uses a real non-superuser, non-bypass role without ownership of tenant tables', async () => {
    const role = await db.one<{
      superuser: boolean;
      bypass: boolean;
      can_create_role: boolean;
      can_create_database: boolean;
    }>(
      `SELECT rolsuper AS superuser,rolbypassrls AS bypass,rolcreaterole AS can_create_role,rolcreatedb AS can_create_database
       FROM pg_roles WHERE rolname=current_user`,
    );
    expect(role).toEqual({
      superuser: false,
      bypass: false,
      can_create_role: false,
      can_create_database: false,
    });
    const ownership = await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND (pg_has_role(current_user,c.relowner,'USAGE') OR pg_has_role(current_user,c.relowner,'SET')) AND
         (c.relname='tenants' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped))`,
    );
    expect(ownership).toEqual([]);
    await expect(db.assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('returns zero rows without context from every tenant table, including tenants', async () => {
    expect(tenantTables.map((table) => table.name)).toContain('tenants');
    expect(tenantTables.length).toBeGreaterThan(1);
    for (const table of tenantTables) {
      expect({
        table: table.name,
        enabled: table.row_security,
        forced: table.force_row_security,
      }).toEqual({ table: table.name, enabled: true, forced: true });
      const tenantColumn = table.name === 'tenants' ? 'id' : 'tenant_id';
      const fixtures = await admin.query(
        `SELECT id FROM ${identifier(table.name)} WHERE ${identifier(tenantColumn)}=ANY($1::uuid[])`,
        [[first.tenantId, second.tenantId]],
      );
      expect(fixtures.rows.length).toBeGreaterThanOrEqual(2);
      expect(await db.query(`SELECT * FROM ${identifier(table.name)}`)).toEqual(
        [],
      );
      expect(
        await db.transaction((tx) =>
          tx.query(`SELECT * FROM ${identifier(table.name)}`),
        ),
      ).toEqual([]);
    }
  });

  it('scopes unfiltered reads and transactions across awaited work to tenant A', async () => {
    await runWithTenant(first.tenantId, async () => {
      await Promise.resolve();
      for (const table of tenantTables) {
        const rows = await db.query<Record<string, string>>(
          `SELECT * FROM ${identifier(table.name)}`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.every(
            (row) =>
              (table.name === 'tenants' ? row.id : row.tenant_id) ===
              first.tenantId,
          ),
        ).toBe(true);
      }
      const rows = await db.transaction(async (tx) => {
        await Promise.resolve();
        return tx.query<{ id: string; tenant_id: string }>(
          'SELECT id,tenant_id FROM candidates',
        );
      });
      expect(rows).toEqual([
        { id: first.candidateId, tenant_id: first.tenantId },
      ]);
    });
  });

  it('clears transaction-local tenant settings when the same pooled connection is reused', async () => {
    const scoped = await runWithTenant(first.tenantId, () =>
      db.one<{ pid: number; tenant: string }>(
        "SELECT pg_backend_pid() AS pid,current_setting('app.tenant_id',true) AS tenant",
      ),
    );
    const unscoped = await db.one<{ pid: number; tenant: string | null }>(
      "SELECT pg_backend_pid() AS pid,current_setting('app.tenant_id',true) AS tenant",
    );
    expect(unscoped?.pid).toBe(scoped?.pid);
    expect(scoped?.tenant).toBe(first.tenantId);
    expect(unscoped?.tenant ?? '').toBe('');
    expect(await db.query('SELECT id FROM candidates')).toEqual([]);
    await expect(
      runWithTenant(first.tenantId, () =>
        db.transaction(async (tx) => {
          await tx.query('SELECT id FROM candidates');
          throw new Error('Deliberate scoped transaction rollback');
        }),
      ),
    ).rejects.toThrow('Deliberate scoped transaction rollback');
    expect(await db.query('SELECT id FROM candidates')).toEqual([]);
    const secondRows = await runWithTenant(second.tenantId, () =>
      db.query<{ id: string }>('SELECT id FROM candidates'),
    );
    expect(secondRows).toEqual([{ id: second.candidateId }]);
    expect(await db.query('SELECT id FROM candidates')).toEqual([]);
  });

  it('keeps concurrent tenant A and B operations isolated in reused pool connections', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) => {
        const tenant = index % 2 ? first : second;
        return runWithTenant(tenant.tenantId, async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const rows =
            index % 3
              ? await db.query<{ id: string; tenant_id: string }>(
                  'SELECT id,tenant_id FROM candidates',
                )
              : await db.transaction(async (tx) => {
                  await Promise.resolve();
                  return tx.query<{ id: string; tenant_id: string }>(
                    'SELECT id,tenant_id FROM candidates',
                  );
                });
          return { rows, tenant };
        });
      }),
    );
    for (const { rows, tenant } of results) {
      expect(rows).toEqual([
        { id: tenant.candidateId, tenant_id: tenant.tenantId },
      ]);
    }
    expect(await db.query('SELECT id FROM candidates')).toEqual([]);
  });

  it('rejects a cross-tenant insert through WITH CHECK and releases the failed transaction', async () => {
    await expect(
      runWithTenant(first.tenantId, () =>
        db.query(
          'INSERT INTO candidates(tenant_id,full_name,email) VALUES($1,$2,$3)',
          [
            second.tenantId,
            'Cross tenant attempt',
            `${randomUUID()}@example.test`,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const remaining = await runWithTenant(first.tenantId, () =>
      db.query<{ id: string }>('SELECT id FROM candidates'),
    );
    expect(remaining).toEqual([{ id: first.candidateId }]);
  });

  it('denies direct update and delete of consent and audit history even within the matching tenant', async () => {
    await runWithTenant(first.tenantId, async () => {
      for (const statement of [
        {
          sql: 'UPDATE consents SET source=$1 WHERE id=$2',
          params: ['Tampered evidence', first.consentId],
        },
        { sql: 'DELETE FROM consents WHERE id=$1', params: [first.consentId] },
        {
          sql: 'UPDATE audit_events SET action=$1 WHERE id=$2',
          params: ['tampered.audit', first.auditId],
        },
        {
          sql: 'DELETE FROM audit_events WHERE id=$1',
          params: [first.auditId],
        },
      ]) {
        await expect(
          db.query(statement.sql, statement.params),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });
    const consent = await admin.query(
      'SELECT source FROM consents WHERE id=$1',
      [first.consentId],
    );
    expect(consent.rows[0].source).toBe('RLS consent fixture');
    const audit = await admin.query(
      'SELECT action FROM audit_events WHERE id=$1',
      [first.auditId],
    );
    expect(audit.rows[0].action).toBe('rls.fixture');
  });

  it('denies DROP TABLE to the application role', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query('DROP TABLE public.onboarding_tasks');
        throw new Error(
          'Application role unexpectedly allowed schema mutation',
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a real superuser connection during production startup', async () => {
    const actualRole = await admin.query<{ superuser: boolean }>(
      'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=current_user',
    );
    expect(actualRole.rows[0].superuser).toBe(true);
    await restoreEnvironment(
      {
        NODE_ENV: 'production',
        DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL!,
        JWT_SECRET: 'production-role-test-secret-0123456789abcdef',
        CORS_ORIGINS: 'https://app.example.com',
        PGSSLMODE: 'disable',
      },
      async () => {
        const unsafe = new DbService();
        try {
          await expect(unsafe.onModuleInit()).rejects.toThrow(
            /unsafe|superuser|bypass|owner/i,
          );
        } finally {
          await unsafe.onModuleDestroy();
        }
      },
    );
  });
  it('rejects the real migration owner during production startup', async () => {
    if (!process.env.DATABASE_MIGRATION_URL) {
      throw new Error(
        'Production ownership tests require DATABASE_MIGRATION_URL for the real non-superuser migration owner.',
      );
    }
    const owner = new Pool({
      connectionString: process.env.DATABASE_MIGRATION_URL,
    });
    try {
      const role = await owner.query<{ superuser: boolean; bypass: boolean }>(
        'SELECT rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user',
      );
      expect(role.rows[0]).toEqual({ superuser: false, bypass: false });
    } finally {
      await owner.end();
    }
    await restoreEnvironment(
      {
        NODE_ENV: 'production',
        DATABASE_URL: process.env.DATABASE_MIGRATION_URL,
        JWT_SECRET: 'production-role-test-secret-0123456789abcdef',
        CORS_ORIGINS: 'https://app.example.com',
        PGSSLMODE: 'disable',
      },
      async () => {
        const unsafe = new DbService();
        try {
          await expect(unsafe.onModuleInit()).rejects.toThrow(/ownership/i);
        } finally {
          await unsafe.onModuleDestroy();
        }
      },
    );
  });

  it('rejects a BYPASSRLS login independently of superuser and table ownership', async () => {
    const roleName = `hireai_test_bypass_${randomUUID().replaceAll('-', '')}`;
    const rolePassword = randomUUID() + randomUUID();
    const database = await admin.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    const create = await admin.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
      [roleName, rolePassword],
    );
    await admin.query(create.rows[0].sql);
    try {
      await admin.query(
        `GRANT CONNECT ON DATABASE ${identifier(database.rows[0].name)} TO ${identifier(roleName)}`,
      );
      const connection = new URL(process.env.TEST_ADMIN_DATABASE_URL!);
      connection.username = roleName;
      connection.password = rolePassword;
      await restoreEnvironment(
        {
          NODE_ENV: 'production',
          DATABASE_URL: connection.toString(),
          JWT_SECRET: 'production-role-test-secret-0123456789abcdef',
          CORS_ORIGINS: 'https://app.example.com',
          PGSSLMODE: 'disable',
        },
        async () => {
          const unsafe = new DbService();
          try {
            await expect(unsafe.onModuleInit()).rejects.toThrow(/BYPASSRLS/);
          } finally {
            await unsafe.onModuleDestroy();
          }
        },
      );
    } finally {
      await admin.query(
        `REVOKE CONNECT ON DATABASE ${identifier(database.rows[0].name)} FROM ${identifier(roleName)}`,
      );
      await admin.query(`DROP ROLE ${identifier(roleName)}`);
    }
  });
  it('rejects a NOINHERIT runtime login that can SET ROLE to the migration owner', async () => {
    const roleName = `hireai_test_set_owner_${randomUUID().replaceAll('-', '')}`;
    const rolePassword = randomUUID() + randomUUID();
    const database = await admin.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    const create = await admin.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
      [roleName, rolePassword],
    );
    await admin.query(create.rows[0].sql);
    try {
      await admin.query(
        `GRANT CONNECT ON DATABASE ${identifier(database.rows[0].name)} TO ${identifier(roleName)}`,
      );
      await admin.query(
        `GRANT hireai_owner TO ${identifier(roleName)} WITH INHERIT FALSE, SET TRUE`,
      );
      const connection = new URL(process.env.TEST_ADMIN_DATABASE_URL!);
      connection.username = roleName;
      connection.password = rolePassword;
      const ownerCapable = new Pool({
        connectionString: connection.toString(),
      });
      try {
        const permissions = await ownerCapable.query<{
          inherited: boolean;
          can_set_owner: boolean;
        }>(
          "SELECT pg_has_role(current_user,'hireai_owner','USAGE') AS inherited,pg_has_role(current_user,'hireai_owner','SET') AS can_set_owner",
        );
        expect(permissions.rows[0]).toEqual({
          inherited: false,
          can_set_owner: true,
        });
      } finally {
        await ownerCapable.end();
      }
      await restoreEnvironment(
        {
          NODE_ENV: 'production',
          DATABASE_URL: connection.toString(),
          JWT_SECRET: 'production-role-test-secret-0123456789abcdef',
          CORS_ORIGINS: 'https://app.example.com',
          PGSSLMODE: 'disable',
        },
        async () => {
          const unsafe = new DbService();
          try {
            await expect(unsafe.onModuleInit()).rejects.toThrow(
              /ownership|owner/i,
            );
          } finally {
            await unsafe.onModuleDestroy();
          }
        },
      );
    } finally {
      try {
        await admin.query(`REVOKE hireai_owner FROM ${identifier(roleName)}`);
      } finally {
        try {
          await admin.query(
            `REVOKE CONNECT ON DATABASE ${identifier(database.rows[0].name)} FROM ${identifier(roleName)}`,
          );
        } finally {
          await admin.query(`DROP ROLE ${identifier(roleName)}`);
        }
      }
    }
  });
});
