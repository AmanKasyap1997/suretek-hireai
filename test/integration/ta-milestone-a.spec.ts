import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JwtService } from '@nestjs/jwt';
import { useApiFixture } from '../helpers/api-fixtures';
import { Role } from '../../src/shared/enums';

describe('Talent acquisition milestone A', () => {
  const f = useApiFixture();
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
  it('guards all tenant tables with enabled, forced tenant_isolation policies', async () => {
    const missing = await f.pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped) AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation' AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL))`,
    );
    expect(missing.rows).toEqual([]);
  });
  it('requires assignment for scoped reads and decisions and revokes access on removal', async () => {
    const { jobId, applicationId } = await f.scenario();
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER),
      interviewer = await f.user(f.tenantA, Role.INTERVIEWER);
    const managerToken = await tokenFor(manager),
      interviewerToken = await tokenFor(interviewer);
    await f.authorized('get', `/jobs/${jobId}`, managerToken).expect(404);
    await f
      .authorized('get', `/applications/${applicationId}`, managerToken)
      .expect(404);
    const empty = await f.authorized('get', '/jobs', managerToken).expect(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.total).toBe(0);
    const assignment = await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(201);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: interviewer.id, role: 'INTERVIEWER' })
      .expect(201);
    await f.authorized('get', `/jobs/${jobId}`, managerToken).expect(200);
    await f
      .authorized(
        'get',
        `/applications/${applicationId}/history`,
        interviewerToken,
      )
      .expect(200);
    await f
      .authorized(
        'patch',
        `/applications/${applicationId}/stage`,
        interviewerToken,
      )
      .send({ stage: 'REJECTED', reasonCode: 'OTHER' })
      .expect(403);
    await f
      .authorized('patch', `/applications/${applicationId}/stage`, managerToken)
      .send({ stage: 'INTERVIEW' })
      .expect(403);
    await f
      .authorized('patch', `/applications/${applicationId}/stage`, managerToken)
      .send({ stage: 'REJECTED' })
      .expect(400);
    await f
      .authorized('patch', `/applications/${applicationId}/stage`, managerToken)
      .send({ stage: 'REJECTED', reasonCode: 'OTHER', note: 'Human decision' })
      .expect(200);
    const history = await f
      .authorized('get', `/applications/${applicationId}/history`, managerToken)
      .expect(200);
    expect(history.body).toEqual([
      expect.objectContaining({
        from_stage: 'SHORTLISTED',
        to_stage: 'REJECTED',
        reason_code: 'OTHER',
        actor_id: manager.id,
      }),
    ]);
    await f
      .authorized('delete', `/jobs/${jobId}/assignments/${assignment.body.id}`)
      .expect(200);
    await f.authorized('get', `/jobs/${jobId}`, managerToken).expect(404);
    await f.authorized('get', `/jobs/${jobId}`, f.tokenB).expect(404);
    await f
      .authorized('get', `/applications/${applicationId}/history`, f.tokenB)
      .expect(404);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`, f.tokenB)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(404);
    await f
      .authorized('get', `/jobs/${jobId}/assignments`, f.tokenB)
      .expect(404);
    await f
      .authorized(
        'delete',
        `/jobs/${jobId}/assignments/${assignment.body.id}`,
        f.tokenB,
      )
      .expect(404);
  });
  it('validates job requirements, tenant FKs, filters and empty-page counts', async () => {
    const input = {
      title: 'Special search job',
      description: 'Detailed job requirements',
      department: 'Engineering',
      location: 'Remote',
      openings: 2,
      employmentType: 'CONTRACT',
      salaryMin: 10,
      salaryMax: 20,
      screeningCriteria: [
        { id: 'one', label: 'Experience', weight: 10, must_have: true },
      ],
    };
    const job = await f.authorized('post', '/jobs').send(input).expect(201);
    expect(job.body.openings).toBe(2);
    expect(job.body.screening_criteria).toEqual(input.screeningCriteria);
    await f
      .authorized('patch', `/jobs/${job.body.id}`)
      .send({ salaryMin: null, salaryMax: null })
      .expect(200);
    await f
      .authorized('post', '/jobs')
      .send({ ...input, salaryMin: 30 })
      .expect(400);
    const list = await f
      .authorized('get', '/jobs?q=Special%20search&offset=100')
      .expect(200);
    expect(list.body.data).toEqual([]);
    expect(list.body.total).toBe(1);
    await f.authorized('get', '/jobs?sort=title;DROP').expect(400);
    await f
      .authorized('post', `/jobs/${job.body.id}/assignments`)
      .send({ userId: f.adminB.id, role: 'HIRING_MANAGER' })
      .expect(404);
    await expect(
      f.pool.query(
        `INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,'HIRING_MANAGER')`,
        [f.tenantB, job.body.id, f.adminB.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('supports revised offers, maker-checker and expiry without losing history', async () => {
    const { applicationId } = await f.scenario();
    const input = {
      applicationId,
      annualCtc: '100000',
      joiningDate: '2027-01-01',
    };
    const first = await f.authorized('post', '/offers').send(input).expect(201);
    await f.authorized('post', '/offers').send(input).expect(409);
    const previous = process.env.OFFER_MAKER_CHECKER;
    process.env.OFFER_MAKER_CHECKER = 'true';
    try {
      await f
        .authorized('post', `/offers/${first.body.id}/approve`)
        .expect(409);
      const checker = await f.user(f.tenantA, Role.HR_ADMIN);
      const token = await tokenFor(checker);
      await f
        .authorized('post', `/offers/${first.body.id}/approve`, token)
        .expect(200);
    } finally {
      if (previous === undefined) delete process.env.OFFER_MAKER_CHECKER;
      else process.env.OFFER_MAKER_CHECKER = previous;
    }
    await f
      .authorized('post', `/offers/${first.body.id}/decline`, f.tokenB)
      .expect(404);
    await f.authorized('post', `/offers/${first.body.id}/decline`).expect(200);
    const second = await f
      .authorized('post', '/offers')
      .send(input)
      .expect(201);
    await f
      .authorized('post', `/offers/${second.body.id}/withdraw`, f.tokenB)
      .expect(404);
    await f
      .authorized('post', `/offers/${second.body.id}/withdraw`)
      .expect(200);
    const third = await f
      .authorized('post', '/offers')
      .send({ ...input, expiresAt: '2099-01-01T00:00:00Z' })
      .expect(201);
    await f.authorized('post', `/offers/${third.body.id}/expire`).expect(409);
    await f.pool.query(
      "UPDATE offers SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [third.body.id],
    );
    await f.authorized('post', `/offers/${third.body.id}/approve`).expect(409);
    await f
      .authorized('post', `/offers/${third.body.id}/expire`, f.tokenB)
      .expect(404);
    await f.authorized('post', `/offers/${third.body.id}/expire`).expect(200);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM offers WHERE tenant_id=$1 AND application_id=$2',
          [f.tenantA, applicationId],
        )
      ).rows,
    ).toHaveLength(3);
    const history = await f
      .authorized('get', `/applications/${applicationId}/history`)
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].to_stage).toBe('OFFER');
  });
  it('records initial events and filters candidates and applications without leaking tenant totals', async () => {
    const { jobId, candidateId } = await f.scenario();
    const created = await f
      .authorized('post', '/applications')
      .send({ jobId, candidateId: f.candidateA })
      .expect(201);
    const history = await f
      .authorized('get', `/applications/${created.body.id}/history`)
      .expect(200);
    expect(history.body).toEqual([
      expect.objectContaining({ from_stage: null, to_stage: 'APPLIED' }),
    ]);
    const list = await f
      .authorized('get', `/applications?jobId=${jobId}&stage=APPLIED`)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(created.body.id);
    const candidates = await f
      .authorized(
        'get',
        `/candidates?jobId=${jobId}&stage=SHORTLISTED&status=PUBLISHED`,
      )
      .expect(200);
    expect(candidates.body.total).toBe(1);
    expect(candidates.body.data[0].id).toBe(candidateId);
    const other = await f
      .authorized('get', `/applications?jobId=${jobId}`, f.tokenB)
      .expect(200);
    expect(other.body.total).toBe(0);
    const otherCandidates = await f
      .authorized('get', `/candidates?jobId=${jobId}`, f.tokenB)
      .expect(200);
    expect(otherCandidates.body.total).toBe(0);
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const token = await tokenFor(manager);
    const empty = await f
      .authorized('get', `/applications?jobId=${jobId}`, token)
      .expect(200);
    expect(empty.body.total).toBe(0);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(201);
    const scoped = await f
      .authorized('get', `/applications?jobId=${jobId}`, token)
      .expect(200);
    expect(scoped.body.total).toBe(2);
    await f
      .authorized('post', `/jobs/${jobId}/close`)
      .send({ closeReason: 'Position filled' })
      .expect(200);
    const closed = await f.authorized('get', `/jobs/${jobId}`).expect(200);
    expect(closed.body.closed_at).toEqual(expect.any(String));
    expect(closed.body.close_reason).toBe('Position filled');
  });
  it('denies cross-tenant inserts and mutation of stage evidence as the runtime role', async () => {
    const { applicationId } = await f.scenario();
    const app = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        f.tenantB,
      ]);
      await expect(
        client.query(
          `INSERT INTO application_stage_events(tenant_id,application_id,to_stage) VALUES($1,$2,'APPLIED')`,
          [f.tenantA, applicationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      await expect(
        client.query(
          'UPDATE application_stage_events SET note=$1 WHERE id=$2',
          ['tamper', randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query('DELETE FROM application_stage_events'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
      await app.end();
    }
  });
});
