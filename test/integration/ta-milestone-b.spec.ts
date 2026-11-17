import { spawnSync } from 'node:child_process';
import { docxResume } from '../helpers/resume';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { useApiFixture, api } from '../helpers/api-fixtures';
import {
  ObjectStoragePort,
  MalwareScanPort,
  PendingMalwareScanner,
} from '../../src/integrations';
import {
  CareersService,
  PrivacyService,
} from '../../src/modules/talent-acquisition';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { DocumentScanStatus, Role } from '../../src/shared/enums';

const pdf = Buffer.from('%PDF-1.7\nSample resume\n%%EOF');
describe('Milestone B intake, evidence, documents and erasure', () => {
  let root: string;
  let ipCounter = 1;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hireai-b-'));
    process.env.RESUME_STORAGE_ROOT = root;
    process.env.TRUST_PROXY = '1';
  });
  const f = useApiFixture();
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTAKE_IP_LIMIT;
    delete process.env.INTAKE_EMAIL_LIMIT;
    delete process.env.RESUME_MAX_BYTES;
    delete process.env.CANDIDATE_RETENTION_DAYS;
  });
  const actor = () => ({
    tenantId: f.tenantA,
    userId: f.adminA.id,
    role: Role.HR_ADMIN,
  });
  const slug = (tenant = f.tenantA) => `tenant-${tenant}`;
  const body = (email = `${randomUUID()}@example.test`) => ({
    fullName: 'Public Applicant',
    email,
    noticeVersion: '2026-11-v1',
  });
  const apply = (
    jobId: string,
    input: object,
    tenant = f.tenantA,
    ip = `192.0.2.${ipCounter++}`,
  ) =>
    request(f.app!.getHttpServer())
      .post(`${api}/public/${slug(tenant)}/jobs/${jobId}/applications`)
      .set('X-Forwarded-For', ip)
      .set('User-Agent', 'Intake integration test')
      .send(input);
  const upload = (
    candidate: string,
    token = f.tokenA,
    bytes: Buffer = pdf,
    name = 'resume.pdf',
  ) =>
    f
      .authorized('post', `/candidates/${candidate}/documents`, token)
      .attach('file', bytes, name);
  const tokenFor = (user: { id: string; tenantId: string }) =>
    f.app!.get(JwtService).signAsync(
      { sub: user.id, tenantId: user.tenantId },
      {
        expiresIn: 900,
        algorithm: 'HS256',
        issuer: 'suretek-hireai',
        audience: 'suretek-api',
      },
    );

  it('resolves only public tenant ids, denies directory access and preserves forced RLS', async () => {
    const app = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      expect(
        (
          await app.query('SELECT public.resolve_public_tenant($1) AS id', [
            slug(),
          ])
        ).rows[0].id,
      ).toBe(f.tenantA);
      expect(
        (
          await app.query('SELECT public.resolve_public_tenant($1) AS id', [
            'unknown-tenant',
          ])
        ).rows[0].id,
      ).toBeNull();
      expect((await app.query('SELECT id,slug FROM tenants')).rows).toEqual([]);
      await expect(
        app.query('SELECT * FROM public_tenant_directory'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.query('UPDATE tenants SET slug=$1 WHERE id=$2', [
          'stolen-slug',
          f.tenantA,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      const fn = await f.pool.query(
        "SELECT prosecdef,proconfig,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='resolve_public_tenant(text)'::regprocedure",
      );
      expect(fn.rows[0].prosecdef).toBe(true);
      expect(fn.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
      expect(fn.rows[0].definition).not.toContain('BYPASSRLS');
      await f.pool.query('UPDATE tenants SET slug=$2 WHERE id=$1', [
        f.tenantA,
        'careers-renamed',
      ]);
      expect(
        (
          await app.query('SELECT public.resolve_public_tenant($1) AS id', [
            'careers-renamed',
          ])
        ).rows[0].id,
      ).toBe(f.tenantA);
      expect(
        (
          await app.query('SELECT public.resolve_public_tenant($1) AS id', [
            slug(),
          ])
        ).rows[0].id,
      ).toBeNull();
      await f.pool.query('UPDATE tenants SET slug=$2 WHERE id=$1', [
        f.tenantA,
        slug(),
      ]);
    } finally {
      await app.end();
    }
  });
  it('exposes published jobs only with an explicit public field projection and strict pagination', async () => {
    const { jobId } = await f.scenario();
    const listed = await request(f.app!.getHttpServer())
      .get(`${api}/public/${slug()}/jobs`)
      .expect(200);
    const job = listed.body.data.find(
      (row: { id: string }) => row.id === jobId,
    );
    expect(job).toBeDefined();
    for (const field of [
      'tenant_id',
      'created_by',
      'hiring_manager_user_id',
      'screening_criteria',
      'salary_min',
      'status',
    ])
      expect(job[field]).toBeUndefined();
    await request(f.app!.getHttpServer())
      .get(`${api}/public/${slug(f.tenantB)}/jobs/${jobId}`)
      .expect(404);
    await request(f.app!.getHttpServer())
      .get(`${api}/public/unknown-tenant/jobs`)
      .expect(404);
    await request(f.app!.getHttpServer())
      .get(`${api}/public/${slug()}/jobs?includeStaff=true`)
      .expect(400);
    await f.pool.query(
      "UPDATE jobs SET status='DRAFT' WHERE tenant_id=$1 AND id=$2",
      [f.tenantA, jobId],
    );
    await request(f.app!.getHttpServer())
      .get(`${api}/public/${slug()}/jobs/${jobId}`)
      .expect(404);
    await apply(jobId, body()).expect(404);
  });
  it('accepts separate default-false consents with evidence and the same response for existing candidates', async () => {
    const { jobId } = await f.scenario();
    const input = body();
    const fresh = await apply(jobId, input).expect(202);
    const repeat = await apply(jobId, {
      ...input,
      fullName: 'Overwritten name',
      consents: { CALL: true, RECORDING: true, TRANSCRIPTION: true },
    }).expect(202);
    expect(repeat.body).toEqual(fresh.body);
    expect(Object.keys(fresh.body)).toEqual(['message']);
    const candidate = (
      await f.pool.query(
        'SELECT * FROM candidates WHERE tenant_id=$1 AND email=$2',
        [f.tenantA, input.email],
      )
    ).rows[0];
    expect(candidate.full_name).toBe(input.fullName);
    const evidence = (
      await f.pool.query(
        'SELECT * FROM consents WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY scope',
        [f.tenantA, candidate.id],
      )
    ).rows;
    expect(evidence).toHaveLength(3);
    expect(evidence.map((row) => row.scope)).toEqual([
      'CALL',
      'RECORDING',
      'TRANSCRIPTION',
    ]);
    for (const row of evidence) {
      expect(row.granted).toBe(false);
      expect(row.verified).toBe(false);
      expect(row.captured_by).toBeNull();
      expect(row.notice_version).toBe(input.noticeVersion);
      expect(row.ip_address).toMatch(/^192\.0\.2\./);
      expect(row.user_agent_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    const event = (
      await f.pool.query(
        'SELECT e.* FROM application_stage_events e JOIN applications a ON a.tenant_id=e.tenant_id AND a.id=e.application_id WHERE a.tenant_id=$1 AND a.candidate_id=$2',
        [f.tenantA, candidate.id],
      )
    ).rows;
    expect(event).toHaveLength(1);
    expect(event[0].actor_id).toBeNull();
    const existing = await apply(jobId, {
      ...body('candidate@example.test'),
      consents: { CALL: true, RECORDING: false, TRANSCRIPTION: true },
    }).expect(202);
    expect(existing.body).toEqual(fresh.body);
    const choices = (
      await f.pool.query(
        'SELECT scope,granted FROM consents WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY scope',
        [f.tenantA, f.candidateA],
      )
    ).rows;
    expect(choices).toEqual([
      { scope: 'CALL', granted: true },
      { scope: 'RECORDING', granted: false },
      { scope: 'TRANSCRIPTION', granted: true },
    ]);
    const other = await apply(jobId, body(), f.tenantB).expect(404);
    expect(other.body.statusCode).toBe(404);
  });
  it('rejects invalid intake and stale notices, and silently discards honeypot submissions', async () => {
    const { jobId } = await f.scenario();
    const input = body();
    await apply(jobId, { ...input, tenantId: f.tenantB }).expect(400);
    await apply(jobId, { ...input, consents: { CALL: 'true' } }).expect(400);
    await apply(jobId, { ...input, noticeVersion: 'old-notice' }).expect(400);
    await apply(jobId, { ...input, website: 'bot.example' }).expect(202);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM candidates WHERE tenant_id=$1 AND email=$2',
          [f.tenantA, input.email],
        )
      ).rows,
    ).toEqual([]);
  });
  it('enforces independent persistent per-email and per-IP intake limits', async () => {
    const { jobId } = await f.scenario();
    process.env.INTAKE_EMAIL_LIMIT = '2';
    process.env.INTAKE_IP_LIMIT = '2';
    const email = body().email;
    await apply(jobId, body(email), f.tenantA, '198.51.100.1').expect(202);
    await apply(jobId, body(email), f.tenantA, '198.51.100.1').expect(202);
    await apply(jobId, body(email), f.tenantA, '198.51.100.1').expect(429);
    await apply(jobId, body(), f.tenantA, '198.51.100.4').expect(202);
    await apply(jobId, body(), f.tenantA, '198.51.100.4').expect(202);
    await apply(jobId, body(), f.tenantA, '198.51.100.4').expect(429);
  });
  it('quarantines public resumes and refuses content spoofing atomically', async () => {
    const { jobId } = await f.scenario();
    const input = body();
    await apply(jobId, {
      ...input,
      resume: {
        filename: '../private-resume.pdf',
        base64: pdf.toString('base64'),
      },
    }).expect(202);
    const row = (
      await f.pool.query(
        'SELECT d.* FROM candidate_documents d JOIN candidates c ON c.tenant_id=d.tenant_id AND c.id=d.candidate_id WHERE d.tenant_id=$1 AND c.email=$2',
        [f.tenantA, input.email],
      )
    ).rows[0];
    expect(row.original_name).toBe('private-resume.pdf');
    expect(row.scan_status).toBe('PENDING');
    expect(row.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(await readFile(join(root, row.object_key))).toEqual(pdf);
    await f
      .authorized(
        'get',
        `/candidates/${row.candidate_id}/documents/${row.id}/download`,
      )
      .expect(409);
    const bad = body();
    await apply(jobId, {
      ...bad,
      resume: {
        filename: 'resume.pdf',
        base64: Buffer.from('not a PDF').toString('base64'),
      },
    }).expect(400);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM candidates WHERE tenant_id=$1 AND email=$2',
          [f.tenantA, bad.email],
        )
      ).rows,
    ).toEqual([]);
  });
  it('does not reveal existing applications through resume validation errors', async () => {
    const { jobId } = await f.scenario();
    const existing = body();
    await apply(jobId, existing).expect(202);
    const storage = jest.spyOn(f.app!.get(ObjectStoragePort), 'put');
    const fresh = body();
    const resume = {
      filename: 'resume.pdf',
      base64: Buffer.from('not a PDF').toString('base64'),
    };
    const invalidNew = await apply(jobId, { ...fresh, resume }).expect(400);
    const invalidExisting = await apply(jobId, {
      ...existing,
      resume,
    }).expect(400);
    expect(invalidExisting.body).toEqual(invalidNew.body);

    process.env.RESUME_MAX_BYTES = '4';
    const oversized = {
      filename: 'resume.pdf',
      base64: pdf.toString('base64'),
    };
    const oversizedNew = await apply(jobId, {
      ...fresh,
      resume: oversized,
    }).expect(413);
    const oversizedExisting = await apply(jobId, {
      ...existing,
      resume: oversized,
    }).expect(413);
    expect(oversizedExisting.body).toEqual(oversizedNew.body);
    expect(storage).not.toHaveBeenCalled();
    expect(
      (
        await f.pool.query(
          'SELECT id FROM candidates WHERE tenant_id=$1 AND email=$2',
          [f.tenantA, fresh.email],
        )
      ).rows,
    ).toEqual([]);
  });
  it('authorizes and audits staff document access, and blocks unscanned or corrupted objects', async () => {
    const candidate = f.candidateA;
    const pending = await upload(candidate).expect(201);
    expect(pending.body.scan_status).toBe('PENDING');
    expect(pending.body.object_key).toBeUndefined();
    await f
      .authorized(
        'get',
        `/candidates/${candidate}/documents/${pending.body.id}/download`,
      )
      .expect(409);
    jest
      .spyOn(f.app!.get(MalwareScanPort), 'scan')
      .mockResolvedValue(DocumentScanStatus.CLEAN);
    const clean = await upload(candidate).expect(201);
    const docx = await upload(
      candidate,
      f.tokenA,
      docxResume(),
      'resume.docx',
    ).expect(201);
    expect(docx.body.content_type).toContain('wordprocessingml');
    const response = await f
      .authorized(
        'get',
        `/candidates/${candidate}/documents/${clean.body.id}/download`,
      )
      .expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/pdf/);
    expect(response.headers['content-disposition']).toContain('attachment');
    const audit = (
      await f.pool.query(
        "SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='candidate.document_downloaded'",
        [f.tenantA, clean.body.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    await upload(candidate, f.tokenB).expect(404);
    await upload(candidate, f.employeeToken).expect(403);
    const interviewer = await f.user(f.tenantA, Role.INTERVIEWER);
    await upload(candidate, await tokenFor(interviewer)).expect(403);
    await f
      .authorized('get', `/candidates/${candidate}/documents`, f.tokenB)
      .expect(404);
    await f
      .authorized('get', `/candidates/${candidate}/documents`, f.employeeToken)
      .expect(403);
    await f
      .authorized(
        'get',
        `/candidates/${candidate}/documents/${clean.body.id}/download`,
        f.tokenB,
      )
      .expect(404);
    await f
      .authorized(
        'get',
        `/candidates/${candidate}/documents/${clean.body.id}/download`,
        f.employeeToken,
      )
      .expect(403);
    await request(f.app!.getHttpServer())
      .get(`${api}/candidates/${candidate}/documents/${clean.body.id}/download`)
      .expect(401);
    jest
      .spyOn(f.app!.get(ObjectStoragePort), 'get')
      .mockResolvedValue(Buffer.from('tampered'));
    await f
      .authorized(
        'get',
        `/candidates/${candidate}/documents/${clean.body.id}/download`,
      )
      .expect(409);
    process.env.RESUME_MAX_BYTES = '4';
    await upload(candidate).expect(413);
    await upload(
      candidate,
      f.tokenA,
      Buffer.from('PK fake'),
      'fake.docx',
    ).expect(413);
  });
  it('erases PII and files while retaining evidence, cancels planned calls and retries storage failures', async () => {
    const { candidateId, applicationId } = await f.scenario();
    await f.pool.query(
      "INSERT INTO call_requests(tenant_id,application_id,requested_by,language,idempotency_key) VALUES($1,$2,$3,'EN',$4)",
      [f.tenantA, applicationId, f.adminA.id, randomUUID()],
    );
    const document = await upload(candidateId).expect(201);
    const key = (
      await f.pool.query(
        'SELECT object_key FROM candidate_documents WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, document.body.id],
      )
    ).rows[0].object_key;
    await f
      .authorized('post', `/candidates/${candidateId}/erase`, f.tokenB)
      .expect(404);
    await f
      .authorized('post', `/candidates/${candidateId}/erase`, f.employeeToken)
      .expect(403);
    const storage = f.app!.get(ObjectStoragePort);
    const remove = jest
      .spyOn(storage, 'delete')
      .mockRejectedValue(new Error('storage offline'));
    const pending = await f
      .authorized('post', `/candidates/${candidateId}/erase`)
      .expect(200);
    expect(pending.body).toEqual({
      id: candidateId,
      erased: true,
      documentsPending: 1,
    });
    const erased = (
      await f.pool.query(
        'SELECT * FROM candidates WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, candidateId],
      )
    ).rows[0];
    expect(erased.full_name).toBe('Erased candidate');
    expect(erased.email).toBe(`erased-${candidateId}@invalid.example`);
    expect(erased.phone).toBeNull();
    await f
      .authorized(
        'get',
        `/candidates/${candidateId}/documents/${document.body.id}/download`,
      )
      .expect(404);
    await upload(candidateId).expect(404);
    expect(
      (
        await f.pool.query(
          'SELECT status FROM call_requests WHERE tenant_id=$1 AND application_id=$2',
          [f.tenantA, applicationId],
        )
      ).rows[0].status,
    ).toBe('CANCELLED');
    remove.mockRestore();
    const done = await f
      .authorized('post', `/candidates/${candidateId}/erase`)
      .expect(200);
    expect(done.body.documentsPending).toBe(0);
    await expect(storage.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await f.pool.query(
          'SELECT id FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2',
          [f.tenantA, candidateId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM consents WHERE tenant_id=$1 AND candidate_id=$2',
          [f.tenantA, candidateId],
        )
      ).rows,
    ).toHaveLength(3);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='candidate.erased'",
          [f.tenantA, candidateId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('retains recent/active candidates and erases only aged dormant candidates in the selected tenant', async () => {
    const privacy = f.app!.get(PrivacyService),
      id = randomUUID(),
      other = randomUUID();
    await f.pool.query(
      "INSERT INTO candidates(id,tenant_id,full_name,email,updated_at) VALUES($1,$2,'Old applicant',$3,now()-interval '400 days'),($4,$5,'Other old applicant',$6,now()-interval '400 days')",
      [
        id,
        f.tenantA,
        `${id}@example.test`,
        other,
        f.tenantB,
        `${other}@example.test`,
      ],
    );
    const { candidateId: active } = await f.scenario();
    await f.pool.query(
      "UPDATE candidates SET updated_at=now()-interval '400 days' WHERE tenant_id=$1 AND id=$2",
      [f.tenantA, active],
    );
    await runWithTenant(f.tenantA, async () => {
      const dry = await privacy.retain(actor(), 100, true);
      expect(dry.eligible).toBe(1);
      expect(dry.erased).toBe(0);
      const result = await privacy.retain(actor());
      expect(result.erased).toBe(1);
    });
    expect(
      (await f.pool.query('SELECT erased_at FROM candidates WHERE id=$1', [id]))
        .rows[0].erased_at,
    ).not.toBeNull();
    for (const candidate of [other, active])
      expect(
        (
          await f.pool.query('SELECT erased_at FROM candidates WHERE id=$1', [
            candidate,
          ])
        ).rows[0].erased_at,
      ).toBeNull();
  });
  it('runs the built retention CLI as hireai_app and rejects an actor from another tenant', async () => {
    const id = randomUUID();
    await f.pool.query(
      "INSERT INTO candidates(id,tenant_id,full_name,email,updated_at) VALUES($1,$2,'CLI retention applicant',$3,now()-interval '400 days')",
      [id, f.tenantA, `${id}@example.test`],
    );
    const run = (actorId: string, extra: string[] = []) =>
      spawnSync(
        process.execPath,
        [
          'dist/scripts/retention.js',
          '--tenant-id',
          f.tenantA,
          '--actor-id',
          actorId,
          ...extra,
        ],
        { encoding: 'utf8', env: process.env, timeout: 20000 },
      );
    const dry = run(f.adminA.id, ['--dry-run']);
    expect(dry.stderr).toBe('');
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).eligible).toBe(1);
    const denied = run(f.adminB.id, ['--dry-run']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('active administrator');
    const done = run(f.adminA.id);
    expect(done.status).toBe(0);
    expect(JSON.parse(done.stdout).erased).toBe(1);
    expect(
      (await f.pool.query('SELECT erased_at FROM candidates WHERE id=$1', [id]))
        .rows[0].erased_at,
    ).not.toBeNull();
  });
  it('protects new tables with RLS, composite FKs and least-privilege evidence grants', async () => {
    const { candidateId } = await f.scenario();
    const app = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await app.connect();
    try {
      for (const table of ['candidate_documents', 'public_intake_limits'])
        expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        f.tenantB,
      ]);
      await expect(
        client.query(
          "INSERT INTO candidate_documents(tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256) VALUES($1,$2,'key','resume.pdf','application/pdf',1,$3)",
          [f.tenantA, candidateId, '0'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        f.tenantB,
      ]);
      await expect(
        client.query(
          "INSERT INTO candidate_documents(tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256) VALUES($1,$2,'key','resume.pdf','application/pdf',1,$3)",
          [f.tenantB, candidateId, '0'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        f.tenantB,
      ]);
      await expect(
        client.query(
          'INSERT INTO public_intake_limits(tenant_id,bucket_key,window_start,hits) VALUES($1,$2,now(),1)',
          [f.tenantA, 'f'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await expect(
        client.query("UPDATE candidate_documents SET sha256='tampered'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query('UPDATE consents SET notice_version=$1', ['tampered']),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM consents')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      client.release();
      await app.end();
    }
  });
  it('keeps arbitrary existing staff consent sources compatible', async () => {
    await f
      .authorized('post', `/candidates/${f.candidateA}/consents`)
      .send({ scope: 'CALL', granted: false, source: 'public-careers' })
      .expect(201);
  });
  it('never treats public self-reported grants as verified calling permission', async () => {
    const { jobId } = await f.scenario();
    const input = body();
    await apply(jobId, {
      ...input,
      consents: { CALL: true, RECORDING: true, TRANSCRIPTION: true },
    }).expect(202);
    const application = (
      await f.pool.query(
        'SELECT a.id FROM applications a JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id WHERE a.tenant_id=$1 AND c.email=$2',
        [f.tenantA, input.email],
      )
    ).rows[0];
    await f
      .authorized('patch', `/applications/${application.id}/stage`)
      .send({ stage: 'SHORTLISTED' })
      .expect(200);
    await f
      .authorized('post', '/call-requests')
      .send({
        applicationId: application.id,
        language: 'EN',
        recording: true,
        transcription: true,
        idempotencyKey: randomUUID(),
      })
      .expect(403);
    const scanner = new PendingMalwareScanner();
    expect(await scanner.scan()).toBe(DocumentScanStatus.PENDING);
  });
  it('keeps rate-limit checks atomic for concurrent submissions', async () => {
    const { jobId } = await f.scenario();
    process.env.INTAKE_EMAIL_LIMIT = '1';
    const careers = f.app!.get(CareersService),
      input = body();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        careers.apply(
          slug(),
          jobId,
          {
            ...input,
            website: '',
            consents: { CALL: false, RECORDING: false, TRANSCRIPTION: false },
          },
          '203.0.113.1',
          'Concurrent test',
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(3);
  });
});
