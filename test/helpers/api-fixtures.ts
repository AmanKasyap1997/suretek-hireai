import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { CallingClock } from '../../src/modules/talent-acquisition';
import { Role, JobStatus, ApplicationStage } from '../../src/shared/enums';

const deriveKey = promisify(scrypt);
const password = 'Integration-only-password-2026!';
export const api = '/api/v1';

interface FixtureUser {
  id: string;
  email: string;
  tenantId: string;
}

export function useApiFixture() {
  let app: INestApplication | undefined;
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let adminA: FixtureUser;
  let adminB: FixtureUser;
  let employeeA: FixtureUser;
  let disabledUser: FixtureUser;
  let tokenA: string;
  let tokenB: string;
  let employeeToken: string;
  let disabledToken: string;
  let candidateA: string;
  let candidateB: string;

  async function user(tenantId: string, role: Role): Promise<FixtureUser> {
    const id = randomUUID();
    const email = `${id}@example.test`;
    const salt = randomBytes(16).toString('hex');
    const key = (await deriveKey(password, salt, 64)) as Buffer;
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,password_hash,full_name,role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        tenantId,
        email,
        `scrypt:${salt}:${key.toString('hex')}`,
        'Test User',
        role,
      ],
    );
    return { id, tenantId, email };
  }

  async function login(fixture: FixtureUser): Promise<string> {
    const response = await request(app!.getHttpServer())
      .post(`${api}/auth/login`)
      .send({ tenantId: fixture.tenantId, email: fixture.email, password })
      .expect(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.password_hash).toBeUndefined();
    return response.body.accessToken;
  }

  function authorized(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    token = tokenA,
  ) {
    const client = request(app!.getHttpServer());
    return client[method](`${api}${path}`).auth(token, { type: 'bearer' });
  }

  async function scenario() {
    const candidateId = randomUUID();
    const jobId = randomUUID();
    const applicationId = randomUUID();
    await pool.query(
      `INSERT INTO candidates (id,tenant_id,full_name,email) VALUES ($1,$2,'Scenario Candidate',$3)`,
      [candidateId, tenantA, `${candidateId}@example.test`],
    );
    await pool.query(
      `INSERT INTO jobs (id,tenant_id,title,description,department,location,status,created_by,call_questions)
       VALUES ($1,$2,'Backend Developer','Build recruitment APIs','Engineering','Remote',$3,$4,'[{"id":"q-relocate","text":"Are you open to working from our Noida office?","answer_type":"yes_no","expected_answer":"yes","criterion_id":null}]')`,
      [jobId, tenantA, JobStatus.PUBLISHED, adminA.id],
    );
    await pool.query(
      `INSERT INTO applications (id,tenant_id,job_id,candidate_id,stage)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        applicationId,
        tenantA,
        jobId,
        candidateId,
        ApplicationStage.SHORTLISTED,
      ],
    );
    return { candidateId, jobId, applicationId };
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'Integration tests require DATABASE_URL pointing to the non-owner application role on a migrated, disposable PostgreSQL database.',
      );
    }
    process.env.JWT_SECRET ??= 'integration-test-secret-minimum-32-characters';
    process.env.CALL_PLANNING_ENABLED = 'true';
    process.env.CALL_TIMEZONE = 'UTC';
    process.env.CALL_WINDOW_START = '09:00';
    process.env.CALL_WINDOW_END = '18:00';
    if (!process.env.TEST_ADMIN_DATABASE_URL) {
      throw new Error(
        'Integration fixtures require TEST_ADMIN_DATABASE_URL with a separate RLS-bypassing administrative connection.',
      );
    }
    pool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    tenantA = randomUUID();
    tenantB = randomUUID();
    await pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2),($3,$4)', [
      tenantA,
      `Integration A ${tenantA}`,
      tenantB,
      `Integration B ${tenantB}`,
    ]);
    adminA = await user(tenantA, Role.HR_ADMIN);
    adminB = await user(tenantB, Role.HR_ADMIN);
    employeeA = await user(tenantA, Role.EMPLOYEE);
    disabledUser = await user(tenantA, Role.RECRUITER);
    // AI calling is on, as an HR Admin would turn it on in Integrations.
    await pool.query(
      'INSERT INTO organization_ai_settings(tenant_id,calling_enabled,updated_by) VALUES($1,true,$2),($3,true,$4)',
      [tenantA, adminA.id, tenantB, adminB.id],
    );
    app = await NestFactory.create(AppModule, {
      logger: false,
      bodyParser: false,
    });
    configureApp(app);
    await app.init();
    jest
      .spyOn(app.get(CallingClock), 'now')
      .mockReturnValue(new Date('2026-01-01T10:00:00Z'));
    tokenA = await login(adminA);
    tokenB = await login(adminB);
    employeeToken = await login(employeeA);
    disabledToken = await login(disabledUser);
    await pool.query(
      'UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',
      [tenantA, disabledUser.id],
    );
    candidateA = randomUUID();
    candidateB = randomUUID();
    await pool.query(
      `INSERT INTO candidates (id,tenant_id,full_name,email) VALUES
       ($1,$2,'Tenant A Candidate','candidate@example.test'),
       ($3,$4,'Tenant B Candidate','candidate@example.test')`,
      [candidateA, tenantA, candidateB, tenantB],
    );
  });

  afterAll(async () => {
    if (pool && tenantA && tenantB) {
      // Delete only fixtures created by this suite, preserving unrelated local data.
      await pool.query(
        'UPDATE consents SET verification_id=NULL,verification_method=NULL WHERE tenant_id=ANY($1::uuid[])',
        [[tenantA, tenantB]],
      );
      for (const table of [
        'call_attempts',
        'application_screenings',
        'application_details',
        'application_repeat_notices',
        'organization_ai_settings',
        'integration_oauth_states',
        'integration_providers',
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
        await pool.query(
          `DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
          [[tenantA, tenantB]],
        );
      }
      await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [
        [tenantA, tenantB],
      ]);
    }
    if (app) await app.close();
    if (pool) await pool.end();
  });
  return {
    get app() {
      return app;
    },
    get pool() {
      return pool;
    },
    get tenantA() {
      return tenantA;
    },
    get tenantB() {
      return tenantB;
    },
    get adminA() {
      return adminA;
    },
    get adminB() {
      return adminB;
    },
    get employeeA() {
      return employeeA;
    },
    get disabledUser() {
      return disabledUser;
    },
    get tokenA() {
      return tokenA;
    },
    get tokenB() {
      return tokenB;
    },
    get employeeToken() {
      return employeeToken;
    },
    get disabledToken() {
      return disabledToken;
    },
    get candidateA() {
      return candidateA;
    },
    get candidateB() {
      return candidateB;
    },
    user,
    login,
    authorized,
    scenario,
  };
}
