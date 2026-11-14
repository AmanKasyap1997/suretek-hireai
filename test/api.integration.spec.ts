import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { CallingClock } from '../src/calling/calling.clock';

const deriveKey = promisify(scrypt);
const password = 'Integration-only-password-2026!';
const api = '/api/v1';

interface FixtureUser {
  id: string;
  email: string;
  tenantId: string;
}

describe('PostgreSQL-backed API invariants', () => {
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

  async function user(tenantId: string, role: string): Promise<FixtureUser> {
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
    method: 'get' | 'post' | 'patch',
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
      `INSERT INTO jobs (id,tenant_id,title,description,department,location,status,created_by)
       VALUES ($1,$2,'Backend Developer','Build recruitment APIs','Engineering','Remote','PUBLISHED',$3)`,
      [jobId, tenantA, adminA.id],
    );
    await pool.query(
      `INSERT INTO applications (id,tenant_id,job_id,candidate_id,stage)
       VALUES ($1,$2,$3,$4,'SHORTLISTED')`,
      [applicationId, tenantA, jobId, candidateId],
    );
    return { candidateId, jobId, applicationId };
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'Integration tests require DATABASE_URL pointing to a migrated, disposable PostgreSQL database.',
      );
    }
    process.env.JWT_SECRET ??= 'integration-test-secret-minimum-32-characters';
    process.env.CALL_PLANNING_ENABLED = 'true';
    process.env.CALL_TIMEZONE = 'UTC';
    process.env.CALL_WINDOW_START = '09:00';
    process.env.CALL_WINDOW_END = '18:00';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    tenantA = randomUUID();
    tenantB = randomUUID();
    await pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2),($3,$4)', [
      tenantA,
      `Integration A ${tenantA}`,
      tenantB,
      `Integration B ${tenantB}`,
    ]);
    adminA = await user(tenantA, 'HR_ADMIN');
    adminB = await user(tenantB, 'HR_ADMIN');
    employeeA = await user(tenantA, 'EMPLOYEE');
    disabledUser = await user(tenantA, 'RECRUITER');
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

  it('exposes public liveness/readiness and requires authentication for business APIs', async () => {
    await request(app!.getHttpServer()).get(`${api}/health/live`).expect(200);
    await request(app!.getHttpServer()).get(`${api}/health/ready`).expect(200);
    await request(app!.getHttpServer()).get(`${api}/candidates`).expect(401);
  });

  it('returns a generic authentication error for a wrong password', async () => {
    const response = await request(app!.getHttpServer())
      .post(`${api}/auth/login`)
      .send({
        tenantId: adminA.tenantId,
        email: adminA.email,
        password: 'incorrect-password',
      })
      .expect(401);
    expect(JSON.stringify(response.body)).not.toContain(adminA.email);
    expect(JSON.stringify(response.body)).not.toContain('password_hash');
  });

  it('rechecks active membership and denies unauthorized roles', async () => {
    await authorized('get', '/candidates', disabledToken).expect(401);
    await authorized('get', '/jobs', employeeToken).expect(403);
  });

  it('preserves one active super admin under concurrent account deactivations', async () => {
    const first = await user(tenantA, 'SUPER_ADMIN');
    const second = await user(tenantA, 'SUPER_ADMIN');
    const jwt = app!.get(JwtService);
    const options = {
      expiresIn: 900,
      algorithm: 'HS256' as const,
      issuer: 'suretek-hireai',
      audience: 'suretek-api',
    };
    const firstToken = await jwt.signAsync(
      { sub: first.id, tenantId: tenantA },
      options,
    );
    const secondToken = await jwt.signAsync(
      { sub: second.id, tenantId: tenantA },
      options,
    );
    const responses = await Promise.all([
      authorized('patch', `/auth/users/${second.id}/status`, firstToken).send({
        active: false,
      }),
      authorized('patch', `/auth/users/${first.id}/status`, secondToken).send({
        active: false,
      }),
    ]);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => [401, 403].includes(response.status)),
    ).toHaveLength(1);
    const remaining = await pool.query(
      "SELECT count(*)::int AS count FROM users WHERE tenant_id=$1 AND role='SUPER_ADMIN' AND active=true",
      [tenantA],
    );
    expect(remaining.rows[0].count).toBe(1);
  });

  it('isolates candidate reads and lists even when email addresses overlap', async () => {
    await authorized('get', `/candidates/${candidateB}`).expect(404);
    await authorized('get', `/candidates/${candidateA}`, tokenB).expect(404);
    const response = await authorized(
      'get',
      '/candidates?limit=100&offset=0',
    ).expect(200);
    expect(
      response.body.data.map((candidate: { id: string }) => candidate.id),
    ).toContain(candidateA);
    expect(
      response.body.data.map((candidate: { id: string }) => candidate.id),
    ).not.toContain(candidateB);
    expect(response.body.pagination).toEqual({ limit: 100, offset: 0 });
  });

  it('validates bodies and prevents client-supplied tenant authority', async () => {
    await authorized('post', '/candidates')
      .send({ fullName: 'Invalid', email: 'not-email' })
      .expect(400);
    await authorized('post', '/candidates')
      .send({
        tenantId: tenantB,
        fullName: 'Injected',
        email: 'injected@example.test',
      })
      .expect(400);
    await authorized('get', '/candidates?limit=1000').expect(400);
    await authorized('get', '/candidates/not-a-uuid').expect(400);
  });

  it('returns client errors for malformed JSON and bodies exceeding the upload limit', async () => {
    await authorized('post', '/candidates')
      .set('Content-Type', 'application/json')
      .send('{"fullName":')
      .expect(400);
    await authorized('post', '/candidates')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }))
      .expect(413);
  });

  it('deduplicates candidate emails without case sensitivity within the same tenant', async () => {
    await authorized('post', '/candidates')
      .send({
        fullName: 'Duplicate Candidate',
        email: 'CANDIDATE@example.test',
      })
      .expect(409);
    const count = await pool.query(
      'SELECT count(*) AS count FROM candidates WHERE tenant_id=$1 AND lower(email)=$2',
      [tenantA, 'candidate@example.test'],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('prevents cross-tenant application references in both API and database constraints', async () => {
    const { jobId } = await scenario();
    await authorized('post', '/applications')
      .send({ jobId, candidateId: candidateB })
      .expect(404);
    await expect(
      pool.query(
        'INSERT INTO applications (tenant_id,job_id,candidate_id) VALUES ($1,$2,$3)',
        [tenantA, jobId, candidateB],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('requires job approval before publishing and human-controlled shortlist before an offer', async () => {
    const created = await authorized('post', '/jobs')
      .send({
        title: 'Node.js Engineer',
        description: 'Build a secure recruitment platform.',
        department: 'Engineering',
        location: 'Remote',
      })
      .expect(201);
    await authorized('post', `/jobs/${created.body.id}/publish`).expect(409);
    await authorized('post', `/jobs/${created.body.id}/approve`).expect(200);
    await authorized('post', `/jobs/${created.body.id}/publish`).expect(200);
    const application = await authorized('post', '/applications')
      .send({
        jobId: created.body.id,
        candidateId: candidateA,
      })
      .expect(201);
    await authorized('patch', `/applications/${application.body.id}/stage`)
      .send({ stage: 'HIRED' })
      .expect(400);
    await authorized('post', '/offers')
      .send({
        applicationId: application.body.id,
        annualCtc: '1200000.00',
        currency: 'INR',
        joiningDate: '2026-12-01',
      })
      .expect(409);
  });

  it('creates exactly one employee, onboarding checklist and audit event under concurrent hire retries', async () => {
    const { candidateId, applicationId } = await scenario();
    const offer = await authorized('post', '/offers')
      .send({
        applicationId,
        annualCtc: '1234567.89',
        currency: 'INR',
        joiningDate: '2026-12-01',
      })
      .expect(201);
    await authorized('post', `/offers/${offer.body.id}/hire`).expect(409);
    await authorized('post', `/offers/${offer.body.id}/approve`).expect(200);
    await authorized('post', `/offers/${offer.body.id}/accept`)
      .send({
        acceptanceReference: 'Candidate acceptance email archive ref-123',
      })
      .expect(200);
    const results = await Promise.all([
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
    ]);
    const employeeId = results[0].body.id;
    expect(results.map((result) => result.body.id)).toEqual([
      employeeId,
      employeeId,
      employeeId,
    ]);
    expect(results[0].body.annual_ctc).toBe('1234567.89');
    expect(results[0].body.candidate_id).toBe(candidateId);
    const employees = await pool.query(
      'SELECT id FROM employees WHERE tenant_id=$1 AND source_offer_id=$2',
      [tenantA, offer.body.id],
    );
    expect(employees.rows).toHaveLength(1);
    const tasks = await pool.query(
      'SELECT id FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2',
      [tenantA, employeeId],
    );
    expect(tasks.rows).toHaveLength(3);
    const application = await pool.query(
      'SELECT stage FROM applications WHERE tenant_id=$1 AND id=$2',
      [tenantA, applicationId],
    );
    expect(application.rows[0].stage).toBe('HIRED');
    const events = await pool.query(
      "SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='employee.created_from_offer'",
      [tenantA, employeeId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it('scopes core HR, reviews leave once and rejects duplicate daily attendance', async () => {
    const { candidateId, applicationId } = await scenario();
    const offerId = randomUUID();
    const employeeId = randomUUID();
    await pool.query(
      `INSERT INTO offers (id,tenant_id,application_id,status,annual_ctc,currency,joining_date,created_by,approved_by,accepted_at,acceptance_reference)
       VALUES ($1,$2,$3,'ACCEPTED','900000.00','INR','2026-12-01',$4,$4,now(),'Fixture acceptance')`,
      [offerId, tenantA, applicationId, adminA.id],
    );
    await pool.query(
      `INSERT INTO employees (id,tenant_id,candidate_id,source_offer_id,employee_code,full_name,email,joining_date,annual_ctc,currency)
       VALUES ($1,$2,$3,$4,$5,'HR Fixture Employee',$6,'2026-12-01','900000.00','INR')`,
      [
        employeeId,
        tenantA,
        candidateId,
        offerId,
        `TEST-${employeeId}`,
        `${employeeId}@example.test`,
      ],
    );
    await authorized('get', `/employees/${employeeId}`, tokenB).expect(404);
    const leaveBody = {
      employeeId,
      type: 'ANNUAL',
      startDate: '2026-12-10',
      endDate: '2026-12-11',
      reason: 'Annual leave',
    };
    await authorized('post', '/leave-requests', tokenB)
      .send(leaveBody)
      .expect(404);
    await authorized('post', '/leave-requests')
      .send({ ...leaveBody, endDate: '2026-12-09' })
      .expect(400);
    const leave = await authorized('post', '/leave-requests')
      .send(leaveBody)
      .expect(201);
    const reviewed = await authorized(
      'post',
      `/leave-requests/${leave.body.id}/review`,
    )
      .send({ status: 'APPROVED' })
      .expect(201);
    expect(reviewed.body.status).toBe('APPROVED');
    await authorized('post', `/leave-requests/${leave.body.id}/review`)
      .send({ status: 'REJECTED' })
      .expect(409);
    const attendance = {
      employeeId,
      workDate: '2026-12-02',
      checkIn: '2026-12-02T09:00:00+05:30',
      checkOut: '2026-12-02T18:00:00+05:30',
    };
    await authorized('post', '/attendance', tokenB)
      .send(attendance)
      .expect(404);
    await authorized('post', '/attendance').send(attendance).expect(201);
    await authorized('post', '/attendance').send(attendance).expect(409);
  });

  it('requires separate recording consent, preserves call idempotency and cancels on revocation', async () => {
    const { candidateId, applicationId } = await scenario();
    const body = {
      applicationId,
      language: 'EN',
      recording: true,
      transcription: false,
      idempotencyKey: randomUUID(),
    };
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: 'CALL',
        granted: true,
        source: 'Candidate opt-in form ref-123',
      })
      .expect(201);
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: 'RECORDING',
        granted: true,
        source: 'Recording opt-in form ref-124',
      })
      .expect(201);
    const planned = await authorized('post', '/call-requests')
      .send(body)
      .expect(201);
    const retry = await authorized('post', '/call-requests')
      .send(body)
      .expect(201);
    expect(retry.body.id).toBe(planned.body.id);
    await authorized('post', '/call-requests')
      .send({ ...body, language: 'HI' })
      .expect(409);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: 'RECORDING',
        granted: false,
        source: 'Candidate withdrawal email ref-125',
      })
      .expect(201);
    const cancelled = await pool.query(
      'SELECT status FROM call_requests WHERE tenant_id=$1 AND id=$2',
      [tenantA, planned.body.id],
    );
    expect(cancelled.rows[0].status).toBe('CANCELLED');
    await authorized('post', '/call-requests')
      .send({ ...body, idempotencyKey: randomUUID() })
      .expect(403);
    const consentHistory = await authorized(
      'get',
      `/candidates/${candidateId}/consents`,
    ).expect(200);
    expect(consentHistory.body.data).toHaveLength(3);
    expect(
      consentHistory.body.latest.find(
        (consent: { scope: string }) => consent.scope === 'RECORDING',
      ).granted,
    ).toBe(false);
  });

  it('rejects planning outside the local calling window', async () => {
    const { candidateId, applicationId } = await scenario();
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: 'CALL',
        granted: true,
        source: 'Candidate opt-in form ref-126',
      })
      .expect(201);
    const clock = app!.get(CallingClock);
    jest.spyOn(clock, 'now').mockReturnValue(new Date('2026-01-01T18:00:00Z'));
    try {
      await authorized('post', '/call-requests')
        .send({
          applicationId,
          language: 'EN',
          recording: false,
          transcription: false,
          idempotencyKey: randomUUID(),
        })
        .expect(403);
    } finally {
      jest
        .spyOn(clock, 'now')
        .mockReturnValue(new Date('2026-01-01T10:00:00Z'));
    }
  });
});
