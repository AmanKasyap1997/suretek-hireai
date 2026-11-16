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
import {
  Role,
  JobStatus,
  ApplicationStage,
  OfferStatus,
  EmployeeStatus,
  ConsentScope,
  CallLanguage,
  CallRequestStatus,
  LeaveType,
  LeaveStatus,
} from '../src/common/enums';

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
       VALUES ($1,$2,'Backend Developer','Build recruitment APIs','Engineering','Remote',$3,$4)`,
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

  it('keeps every persisted enum constraint and default aligned with the canonical values', async () => {
    const columns: Array<{
      table: string;
      column: string;
      values: string[];
      defaultValue?: string;
    }> = [
      { table: 'users', column: 'role', values: Object.values(Role) },
      {
        table: 'jobs',
        column: 'status',
        values: Object.values(JobStatus),
        defaultValue: JobStatus.DRAFT,
      },
      {
        table: 'applications',
        column: 'stage',
        values: Object.values(ApplicationStage),
        defaultValue: ApplicationStage.APPLIED,
      },
      {
        table: 'offers',
        column: 'status',
        values: Object.values(OfferStatus),
        defaultValue: OfferStatus.DRAFT,
      },
      {
        table: 'employees',
        column: 'status',
        values: Object.values(EmployeeStatus),
        defaultValue: EmployeeStatus.ACTIVE,
      },
      {
        table: 'consents',
        column: 'scope',
        values: Object.values(ConsentScope),
      },
      {
        table: 'call_requests',
        column: 'language',
        values: Object.values(CallLanguage),
      },
      {
        table: 'call_requests',
        column: 'status',
        values: Object.values(CallRequestStatus),
        defaultValue: CallRequestStatus.PLANNED,
      },
      {
        table: 'leave_requests',
        column: 'type',
        values: Object.values(LeaveType),
      },
      {
        table: 'leave_requests',
        column: 'status',
        values: Object.values(LeaveStatus),
        defaultValue: LeaveStatus.PENDING,
      },
    ];
    for (const column of columns) {
      const constraint = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid=$1::regclass AND conname=$2 AND contype='c'`,
        [column.table, `${column.table}_${column.column}_check`],
      );
      expect(constraint.rows).toHaveLength(1);
      const persistedValues = Array.from(
        constraint.rows[0].definition.matchAll(/'([^']*)'/g),
        (match) => match[1],
      );
      expect(persistedValues.sort()).toEqual([...column.values].sort());
      const defaults = await pool.query<{ expression: string }>(
        `SELECT pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
         WHERE d.adrelid=$1::regclass AND a.attname=$2`,
        [column.table, column.column],
      );
      expect(defaults.rows[0]?.expression.match(/'([^']*)'/)?.[1]).toBe(
        column.defaultValue,
      );
    }
  });

  it('accepts every canonical role in PostgreSQL and rejects an undeclared role', async () => {
    const hash = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2',
      [tenantA, adminA.id],
    );
    const accepted = await pool.query<{ role: string }>(
      `INSERT INTO users(tenant_id,email,password_hash,full_name,role,active)
       SELECT $1,gen_random_uuid()::text || '@example.test',$2,'Canonical role fixture',role,false
       FROM unnest($3::text[]) AS canonical(role) RETURNING role`,
      [tenantA, hash.rows[0].password_hash, Object.values(Role)],
    );
    expect(accepted.rows.map((row) => row.role).sort()).toEqual(
      Object.values(Role).sort(),
    );
    await expect(
      pool.query(
        `INSERT INTO users(tenant_id,email,password_hash,full_name,role,active)
       VALUES($1,$2,$3,'Invalid role fixture',$4,false)`,
        [
          tenantA,
          `${randomUUID()}@example.test`,
          hash.rows[0].password_hash,
          'NOT_A_PLATFORM_ROLE',
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
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
    const first = await user(tenantA, Role.SUPER_ADMIN);
    const second = await user(tenantA, Role.SUPER_ADMIN);
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
      'SELECT count(*)::int AS count FROM users WHERE tenant_id=$1 AND role=$2 AND active=true',
      [tenantA, Role.SUPER_ADMIN],
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

  it('denies tenant A reads and mutations for tenant B records by ID', async () => {
    const jobId = randomUUID();
    const applicationId = randomUUID();
    const offerId = randomUUID();
    await pool.query(
      `INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by)
       VALUES($1,$2,'Private tenant B job','Tenant B recruitment position','Engineering','Remote',$3,$4)`,
      [jobId, tenantB, JobStatus.PUBLISHED, adminB.id],
    );
    await pool.query(
      `INSERT INTO applications(id,tenant_id,job_id,candidate_id,stage) VALUES($1,$2,$3,$4,$5)`,
      [applicationId, tenantB, jobId, candidateB, ApplicationStage.SHORTLISTED],
    );
    await pool.query(
      `INSERT INTO offers(id,tenant_id,application_id,status,annual_ctc,currency,joining_date,created_by)
       VALUES($1,$2,$3,$4,'1200000.00','INR','2026-12-01',$5)`,
      [offerId, tenantB, applicationId, OfferStatus.DRAFT, adminB.id],
    );
    await authorized('get', `/jobs/${jobId}`).expect(404);
    await authorized('patch', `/jobs/${jobId}`)
      .send({ title: 'Unauthorized change' })
      .expect(404);
    await authorized('post', `/jobs/${jobId}/close`).expect(404);
    await authorized('get', `/candidates/${candidateB}`).expect(404);
    await authorized('post', `/candidates/${candidateB}/consents`)
      .send({
        scope: ConsentScope.CALL,
        granted: true,
        source: 'Unauthorized cross-tenant attempt',
      })
      .expect(404);
    await authorized('get', `/applications/${applicationId}`).expect(404);
    await authorized('patch', `/applications/${applicationId}/stage`)
      .send({ stage: ApplicationStage.INTERVIEW })
      .expect(404);
    await authorized('get', `/offers/${offerId}`).expect(404);
    await authorized('post', `/offers/${offerId}/approve`).expect(404);
    await authorized('post', `/offers/${offerId}/accept`)
      .send({ acceptanceReference: 'Unauthorized acceptance attempt' })
      .expect(404);
    await authorized('post', `/offers/${offerId}/hire`).expect(404);
    const unchanged = await pool.query(
      `SELECT j.title,j.status,a.stage,o.status AS offer_status FROM jobs j
       JOIN applications a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
       JOIN offers o ON o.tenant_id=a.tenant_id AND o.application_id=a.id
       WHERE j.tenant_id=$1 AND j.id=$2`,
      [tenantB, jobId],
    );
    expect(unchanged.rows[0]).toEqual({
      title: 'Private tenant B job',
      status: JobStatus.PUBLISHED,
      stage: ApplicationStage.SHORTLISTED,
      offer_status: OfferStatus.DRAFT,
    });
    const unauthorizedConsents = await pool.query(
      'SELECT id FROM consents WHERE tenant_id=$1 AND candidate_id=$2',
      [tenantB, candidateB],
    );
    expect(unauthorizedConsents.rows).toEqual([]);
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
      .send({ stage: ApplicationStage.HIRED })
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
    expect(application.rows[0].stage).toBe(ApplicationStage.HIRED);
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
       VALUES ($1,$2,$3,$4,'900000.00','INR','2026-12-01',$5,$5,now(),'Fixture acceptance')`,
      [offerId, tenantA, applicationId, OfferStatus.ACCEPTED, adminA.id],
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
      type: LeaveType.ANNUAL,
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
      .send({ status: LeaveStatus.APPROVED })
      .expect(201);
    expect(reviewed.body.status).toBe(LeaveStatus.APPROVED);
    await authorized('post', `/leave-requests/${leave.body.id}/review`)
      .send({ status: LeaveStatus.REJECTED })
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
      language: CallLanguage.EN,
      recording: true,
      transcription: false,
      idempotencyKey: randomUUID(),
    };
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.CALL,
        granted: true,
        source: 'Candidate opt-in form ref-123',
      })
      .expect(201);
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.RECORDING,
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
      .send({ ...body, language: CallLanguage.HI })
      .expect(409);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.RECORDING,
        granted: false,
        source: 'Candidate withdrawal email ref-125',
      })
      .expect(201);
    const cancelled = await pool.query(
      'SELECT status FROM call_requests WHERE tenant_id=$1 AND id=$2',
      [tenantA, planned.body.id],
    );
    expect(cancelled.rows[0].status).toBe(CallRequestStatus.CANCELLED);
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
        (consent: { scope: string }) =>
          consent.scope === ConsentScope.RECORDING,
      ).granted,
    ).toBe(false);
  });

  it('rejects planning outside the local calling window', async () => {
    const { candidateId, applicationId } = await scenario();
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.CALL,
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
          language: CallLanguage.EN,
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
