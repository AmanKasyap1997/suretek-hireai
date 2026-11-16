import { useApiFixture } from '../helpers/api-fixtures';
import { ApplicationStage } from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('prevents cross-tenant application references in both API and database constraints', async () => {
    const { pool, tenantA, candidateB, authorized, scenario } = fixture;
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
    const { candidateA, authorized } = fixture;
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
});
