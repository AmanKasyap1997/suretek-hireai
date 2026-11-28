import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { DbService } from '../src/platform/database/db.service';
import { runWithTenant } from '../src/platform/database/tenant-context';
import {
  ApplicationStage,
  CallLanguage,
  ConsentScope,
  JobStatus,
  InterviewMode,
  InterviewStatus,
  ScorecardRecommendation,
  LeaveType,
  OfferStatus,
  Role,
} from '../src/shared/enums';

interface TenantFixture {
  tenantId: string;
  organizationId: string;
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
  const interviewId = randomUUID();
  const offerId = randomUUID();
  const employeeId = randomUUID();
  const consentId = randomUUID();
  const auditId = randomUUID();
  const documentId = randomUUID();
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
    `INSERT INTO public_intake_limits(tenant_id,bucket_key,window_start,hits) VALUES($1,$2,now(),1)`,
    [tenantId, '0'.repeat(64)],
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
    `INSERT INTO candidate_documents(id,tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256) VALUES($1,$2,$3,$4,'fixture.pdf','application/pdf',8,$5)`,
    [
      documentId,
      tenantId,
      candidateId,
      `${tenantId}/${randomUUID()}`,
      '0'.repeat(64),
    ],
  );
  await client.query(
    `INSERT INTO applications(id,tenant_id,job_id,candidate_id,stage) VALUES($1,$2,$3,$4,$5)`,
    [applicationId, tenantId, jobId, candidateId, ApplicationStage.HIRED],
  );
  await client.query(
    `INSERT INTO application_details(tenant_id,application_id,current_location,total_experience_months,notice_period,expected_ctc)
     VALUES($1,$2,'Remote',24,'IMMEDIATE','900000.00')`,
    [tenantId, applicationId],
  );
  await client.query(
    'INSERT INTO application_repeat_notices(tenant_id,application_id) VALUES($1,$2)',
    [tenantId, applicationId],
  );
  await client.query(
    `INSERT INTO application_screenings(tenant_id,application_id,document_id,trigger,requested_by,criteria)
     VALUES($1,$2,$3,'MANUAL',$4,'[]'::jsonb)`,
    [tenantId, applicationId, documentId, userId],
  );
  await client.query(
    'INSERT INTO organization_ai_settings(tenant_id,updated_by) VALUES($1,$2)',
    [tenantId, userId],
  );
  const startsAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 3600000).toISOString();
  await client.query(
    `INSERT INTO interviews(id,tenant_id,application_id,round,mode,starts_at,ends_at,status,created_by)
     VALUES($1,$2,$3,'RLS interview fixture',$4,$5,$6,$7,$8)`,
    [
      interviewId,
      tenantId,
      applicationId,
      InterviewMode.PHONE,
      startsAt,
      endsAt,
      InterviewStatus.SCHEDULED,
      userId,
    ],
  );
  await client.query(
    `INSERT INTO interview_panelists(tenant_id,interview_id,user_id,starts_at,ends_at,status)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      tenantId,
      interviewId,
      userId,
      startsAt,
      endsAt,
      InterviewStatus.SCHEDULED,
    ],
  );
  await client.query(
    `INSERT INTO interview_scorecards(tenant_id,interview_id,panelist_user_id,scores,recommendation)
     VALUES($1,$2,$3,'[]'::jsonb,$4)`,
    [tenantId, interviewId, userId, ScorecardRecommendation.HOLD],
  );
  await client.query(
    `INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,'RECRUITER_OWNER')`,
    [tenantId, jobId, userId],
  );
  await client.query(
    `INSERT INTO application_stage_events(tenant_id,application_id,to_stage,actor_id) VALUES($1,$2,'HIRED',$3)`,
    [tenantId, applicationId, userId],
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
    `INSERT INTO contact_verifications(tenant_id,candidate_id,application_id,token_hash,email_hash,call_consent_id,recording_consent_id,transcription_consent_id,expires_at) VALUES($1,$2,$3,$4,$4,$5,$5,$5,now()+interval '1 hour')`,
    [tenantId, candidateId, applicationId, '0'.repeat(64), consentId],
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
  const organizationId = randomUUID(),
    organizationAdmin = randomUUID(),
    organizationInvite = randomUUID();
  await client.query(
    "INSERT INTO user_invitations(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
    [tenantId, userId, '1'.repeat(64)],
  );
  await client.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    organizationId,
    'RLS organization fixture',
  ]);
  await client.query(
    "INSERT INTO users(id,tenant_id,email,password_hash,full_name,role,active,invitation_pending) VALUES($1,$2,$3,'!invitation-pending','RLS invited admin','HR_ADMIN',false,true)",
    [organizationAdmin, organizationId, `${organizationAdmin}@example.test`],
  );
  await client.query(
    "INSERT INTO user_invitations(id,tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
    [organizationInvite, organizationId, organizationAdmin, '2'.repeat(64)],
  );
  await client.query(
    'INSERT INTO platform_organizations(tenant_id,organization_id,admin_user_id,name,slug,admin_email,admin_name,last_invitation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      tenantId,
      organizationId,
      organizationAdmin,
      'RLS organization',
      `rls-${organizationId}`,
      `${organizationAdmin}@example.test`,
      'RLS admin',
      organizationInvite,
    ],
  );
  await client.query(
    "INSERT INTO integration_configs(tenant_id,scope,provider,environment,encrypted_credentials,credential_hint,updated_by) VALUES($1,'platform','openai','sandbox','fixture-ciphertext','****test',$2)",
    [tenantId, userId],
  );
  await client.query(
    "INSERT INTO platform_settings(tenant_id,key,value,updated_by) VALUES($1,'rls_fixture','{}',$2)",
    [tenantId, userId],
  );
  await client.query(
    "INSERT INTO integration_oauth_states(tenant_id,user_id,state_hash,encrypted_payload) VALUES($1,$2,$3,'fixture-encrypted-payload')",
    [tenantId, userId, randomUUID()],
  );
  await client.query(
    "INSERT INTO integration_publications(tenant_id,job_id,connection_id,channel,payload,job_updated_at,created_by) SELECT $1,$2,id,'company_announcement','{}',now(),$3 FROM integration_configs WHERE tenant_id=$1 LIMIT 1",
    [tenantId, jobId, userId],
  );
  await client.query(
    `INSERT INTO call_attempts(tenant_id,call_request_id,number,connection_id)
     SELECT $1,cr.id,1,ic.id FROM call_requests cr,integration_configs ic
     WHERE cr.tenant_id=$1 AND ic.tenant_id=$1 LIMIT 1`,
    [tenantId],
  );
  return { tenantId, organizationId, userId, candidateId, consentId, auditId };
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
    // Provider availability is intentionally shared non-secret metadata. Its
    // write policy is covered by organization-integrations API/database tests.
    tenantTables = (
      await admin.query<TenantTable>(
        `SELECT c.relname AS name,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'integration_providers' AND
         (c.relname='tenants' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped))
       ORDER BY c.relname`,
      )
    ).rows;
  });

  afterAll(async () => {
    if (admin && first && second) {
      await admin.query(
        'UPDATE consents SET verification_id=NULL,verification_method=NULL WHERE tenant_id=ANY($1::uuid[])',
        [
          [
            first.tenantId,
            second.tenantId,
            first.organizationId,
            second.organizationId,
          ],
        ],
      );
      for (const table of [
        'call_attempts',
        'application_screenings',
        'application_details',
        'application_repeat_notices',
        'organization_ai_settings',
        'integration_oauth_states',
        'integration_publications',
        'integration_configs',
        'platform_settings',
        'platform_organizations',
        'user_invitations',
        'interview_scorecards',
        'interview_panelists',
        'interviews',
        'contact_verifications',
        'candidate_documents',
        'public_intake_limits',
        'application_stage_events',
        'job_assignments',
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
          [
            [
              first.tenantId,
              second.tenantId,
              first.organizationId,
              second.organizationId,
            ],
          ],
        );
      }
      await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [
        [
          first.tenantId,
          second.tenantId,
          first.organizationId,
          second.organizationId,
        ],
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
        `SELECT 1 FROM ${identifier(table.name)} WHERE ${identifier(tenantColumn)}=ANY($1::uuid[])`,
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
        EMAIL_DISABLED_ACKNOWLEDGED: 'true',
        MALWARE_SCANNER: 'pending',
        CAPTCHA_DISABLED_ACKNOWLEDGED: 'true',
        RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
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
        EMAIL_DISABLED_ACKNOWLEDGED: 'true',
        MALWARE_SCANNER: 'pending',
        CAPTCHA_DISABLED_ACKNOWLEDGED: 'true',
        RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
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
          EMAIL_DISABLED_ACKNOWLEDGED: 'true',
          MALWARE_SCANNER: 'pending',
          CAPTCHA_DISABLED_ACKNOWLEDGED: 'true',
          RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
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
          EMAIL_DISABLED_ACKNOWLEDGED: 'true',
          MALWARE_SCANNER: 'pending',
          CAPTCHA_DISABLED_ACKNOWLEDGED: 'true',
          RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
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
