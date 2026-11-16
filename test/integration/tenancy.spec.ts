import { useApiFixture } from '../helpers/api-fixtures';
import { randomUUID } from 'node:crypto';
import {
  JobStatus,
  ApplicationStage,
  OfferStatus,
  ConsentScope,
} from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('isolates candidate reads and lists even when email addresses overlap', async () => {
    const { tokenB, candidateA, candidateB, authorized } = fixture;
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
    const { pool, tenantB, adminB, candidateB, authorized } = fixture;
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
});
