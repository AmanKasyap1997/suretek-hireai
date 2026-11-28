import { CallingClock } from '../../src/modules/talent-acquisition';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  EmailPort,
  MalwareScanPort,
  CaptchaPort,
  ObjectStoragePort,
} from '../../src/integrations';
import { DocumentsScanService } from '../../src/modules/talent-acquisition';
import { DocumentScanStatus as S, Role } from '../../src/shared/enums';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { DbService } from '../../src/platform/database/db.service';
import { useApiFixture, api } from '../helpers/api-fixtures';
describe('Milestone D readiness', () => {
  beforeAll(() => {
    process.env.TRUST_PROXY = '1';
  });
  const f = useApiFixture();
  beforeEach(() =>
    jest
      .spyOn(f.app!.get(CallingClock), 'now')
      .mockReturnValue(new Date('2026-01-01T10:00:00Z')),
  );
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTAKE_EMAIL_LIMIT;
    delete process.env.MALWARE_SCANNER;
  });
  const slug = () => `tenant-${f.tenantA}`;
  /** `consents`: separate choices (API); null: only the apply form's notice. */
  async function intake(
    consents: Record<string, boolean> | null = {
      CALL: true,
      RECORDING: false,
      TRANSCRIPTION: false,
    },
  ) {
    const { jobId } = await f.scenario();
    const send = jest
      .spyOn(f.app!.get(EmailPort), 'sendContactVerification')
      .mockResolvedValue(true);
    const body = {
      fullName: 'Verified Applicant',
      email: `${randomUUID()}@example.test`,
      phone: '+919876543210',
      currentLocation: 'Noida',
      totalExperienceMonths: 24,
      noticePeriod: 'IMMEDIATE',
      expectedCtc: 900000,
      privacyAccepted: true,
      noticeVersion: '2026-11-v1',
      ...(consents ? { consents } : {}),
      resume: {
        filename: 'resume.pdf',
        base64: Buffer.from('%PDF-1.7\nSample resume\n%%EOF').toString(
          'base64',
        ),
      },
    };
    const response = await request(f.app!.getHttpServer())
      .post(`${api}/public/${slug()}/jobs/${jobId}/applications`)
      .send(body)
      .expect(202);
    return {
      jobId,
      body,
      response, // Undefined when no confirmation email was sent (the notice).
      mail: send.mock.calls.at(-1)?.[0] as Parameters<
        EmailPort['sendContactVerification']
      >[0],
    };
  }
  const verify = (token: string, tenant = slug()) =>
    request(f.app!.getHttpServer())
      .post(`${api}/public/${tenant}/contact-verification`)
      .send({ token });
  it('stores only token hashes, appends verified evidence once and isolates tenants', async () => {
    const { mail } = await intake();
    const id = mail.token.split('.')[0];
    const row = (
      await f.pool.query('SELECT * FROM contact_verifications WHERE id=$1', [
        id,
      ])
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(mail.token.split('.')[1]);
    const foreign = await verify(mail.token, `tenant-${f.tenantB}`).expect(202);
    const responses = await Promise.all([
      verify(mail.token).expect(202),
      verify(mail.token).expect(202),
    ]);
    expect(responses[0].body).toEqual(foreign.body);
    const evidence = (
      await f.pool.query(
        'SELECT * FROM consents WHERE tenant_id=$1 AND candidate_id=$2',
        [f.tenantA, row.candidate_id],
      )
    ).rows;
    expect(evidence.filter((x) => x.verified)).toHaveLength(3);
    expect(evidence.filter((x) => !x.verified)).toHaveLength(3);
    expect(
      evidence
        .filter((x) => x.verified)
        .every((x) => x.verification_method === 'EMAIL_TOKEN'),
    ).toBe(true);
    const db = f.app!.get(DbService);
    expect(
      await runWithTenant(f.tenantB, () =>
        db.query('SELECT * FROM contact_verifications WHERE id=$1', [id]),
      ),
    ).toEqual([]);
  });
  it('lets the candidate’s choice on the application decide calls, and blocks erased candidates', async () => {
    const shortlisted = async (email: string) => {
      const { id } = (
        await f.pool.query(
          'SELECT a.id FROM applications a JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id WHERE a.tenant_id=$1 AND c.email=$2',
          [f.tenantA, email],
        )
      ).rows[0];
      await f
        .authorized('patch', `/applications/${id}/stage`)
        .send({ stage: 'SHORTLISTED' })
        .expect(200);
      return id;
    };
    const call = (applicationId: string) =>
      f.authorized('post', '/call-requests').send({
        applicationId,
        language: 'EN',
        idempotencyKey: randomUUID(),
      });
    // The apply form's notice: callable straight away, no email to confirm.
    const noticed = await intake(null);
    expect(noticed.mail).toBeUndefined();
    await call(await shortlisted(noticed.body.email)).expect(201);
    // A separate "yes" from an API client counts without the email, too.
    const yes = await intake();
    await call(await shortlisted(yes.body.email)).expect(201);
    // A separate "no" is respected.
    const no = await intake({
      CALL: false,
      RECORDING: false,
      TRANSCRIPTION: false,
    });
    await call(await shortlisted(no.body.email)).expect(403);
    const second = await intake();
    const erased = (
      await f.pool.query('SELECT * FROM contact_verifications WHERE id=$1', [
        second.mail.token.split('.')[0],
      ])
    ).rows[0];
    await f
      .authorized('post', `/candidates/${erased.candidate_id}/erase`)
      .expect(200);
    await verify(second.mail.token).expect(202);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM consents WHERE tenant_id=$1 AND verification_id=$2',
          [f.tenantA, erased.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it('caps guesses, expires tokens and does not override later staff revocation', async () => {
    const { mail } = await intake();
    const id = mail.token.split('.')[0];
    for (let i = 0; i < 5; i++)
      await verify(`${id}.${'A'.repeat(43)}`).expect(202);
    await verify(mail.token).expect(202);
    expect(
      (
        await f.pool.query(
          'SELECT used_at FROM contact_verifications WHERE id=$1',
          [id],
        )
      ).rows[0].used_at,
    ).toBeNull();
    const second = await intake();
    const row = (
      await f.pool.query('SELECT * FROM contact_verifications WHERE id=$1', [
        second.mail.token.split('.')[0],
      ])
    ).rows[0];
    await f
      .authorized('post', `/candidates/${row.candidate_id}/consents`)
      .send({ scope: 'CALL', granted: false, source: 'Staff revocation' })
      .expect(201);
    await verify(second.mail.token).expect(202);
    expect(
      (
        await f.pool.query(
          "SELECT granted FROM consents WHERE tenant_id=$1 AND candidate_id=$2 AND scope='CALL' AND verified ORDER BY sequence_id DESC LIMIT 1",
          [f.tenantA, row.candidate_id],
        )
      ).rows[0].granted,
    ).toBe(false);
    const third = await intake();
    await f.pool.query(
      "UPDATE contact_verifications SET expires_at=now()-interval '1 second' WHERE id=$1",
      [third.mail.token.split('.')[0]],
    );
    await verify(third.mail.token).expect(202);
    expect(
      (
        await f.pool.query(
          'SELECT used_at FROM contact_verifications WHERE id=$1',
          [third.mail.token.split('.')[0]],
        )
      ).rows[0].used_at,
    ).toBeNull();
  });
  it('does not let a different client exhaust a victims email bucket', async () => {
    const { jobId, body } = await intake();
    process.env.INTAKE_EMAIL_LIMIT = '1';
    const apply = (ip: string) =>
      request(f.app!.getHttpServer())
        .post(`${api}/public/${slug()}/jobs/${jobId}/applications`)
        .set('X-Forwarded-For', ip)
        .send(body);
    await apply('192.0.2.20').expect(202);
    await apply('192.0.2.20').expect(429);
    await apply('192.0.2.21').expect(202);
    const captcha = jest
      .spyOn(f.app!.get(CaptchaPort), 'verify')
      .mockResolvedValue(false);
    await apply('192.0.2.22').expect(403);
    captcha.mockResolvedValue(true);
    await apply('192.0.2.22').expect(202);
  });
  it('sweeps pending documents, caps failures and permanently quarantines infected objects', async () => {
    const scanner = jest
      .spyOn(f.app!.get(MalwareScanPort), 'scan')
      .mockResolvedValue(S.PENDING);
    // Earlier tests' applications uploaded resumes; mark those scanned so the
    // sweep sees only this test's two uploads.
    await f.pool.query(
      "UPDATE candidate_documents SET scan_status='CLEAN',scanned_at=now() WHERE tenant_id=$1 AND scan_status IN ('PENDING','FAILED','ERROR')",
      [f.tenantA],
    );
    const upload = () =>
      f
        .authorized('post', `/candidates/${f.candidateA}/documents`)
        .attach('file', Buffer.from('%PDF-1.7\nscan test'), 'resume.pdf')
        .expect(201);
    const a = await upload(),
      b = await upload();
    process.env.MALWARE_SCANNER = 'clamav';
    scanner.mockResolvedValueOnce(S.CLEAN).mockResolvedValueOnce(S.INFECTED);
    const actor = {
      tenantId: f.tenantA,
      userId: f.adminA.id,
      role: Role.HR_ADMIN,
    };
    const service = f.app!.get(DocumentsScanService);
    expect(await runWithTenant(f.tenantA, () => service.sweep(actor))).toEqual({
      scanned: 2,
      clean: 1,
      infected: 1,
      failed: 0,
    });
    await f
      .authorized(
        'get',
        `/candidates/${f.candidateA}/documents/${a.body.id}/download`,
      )
      .expect(200);
    await f
      .authorized(
        'get',
        `/candidates/${f.candidateA}/documents/${b.body.id}/download`,
      )
      .expect(409);
    await expect(
      runWithTenant(f.tenantA, () =>
        f
          .app!.get(DbService)
          .query(
            "UPDATE candidate_documents SET scan_status='CLEAN' WHERE tenant_id=$1 AND id=$2",
            [f.tenantA, b.body.id],
          ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      runWithTenant(f.tenantA, () =>
        service.sweep({ ...actor, role: Role.RECRUITER }),
      ),
    ).rejects.toThrow();
    expect(
      await runWithTenant(f.tenantB, () =>
        service.sweep({ ...actor, tenantId: f.tenantB, userId: f.adminB.id }),
      ),
    ).toEqual({ scanned: 0, clean: 0, infected: 0, failed: 0 });
    scanner.mockResolvedValue(S.PENDING);
    const c = await upload();
    jest
      .spyOn(f.app!.get(ObjectStoragePort), 'get')
      .mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 3; i++)
      expect(
        (await runWithTenant(f.tenantA, () => service.sweep(actor))).failed,
      ).toBe(1);
    expect(
      (await runWithTenant(f.tenantA, () => service.sweep(actor))).scanned,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          'SELECT scan_status,scan_attempts FROM candidate_documents WHERE id=$1',
          [c.body.id],
        )
      ).rows[0],
    ).toEqual({ scan_status: S.FAILED, scan_attempts: 3 });
  });
});
