import { randomUUID } from 'node:crypto';
import { ApplicationStage } from '../../src/shared/enums';
import { useApiFixture } from '../helpers/api-fixtures';

/** What the Candidates page asks the API for. */
describe('Candidates page API', () => {
  const f = useApiFixture();
  const scope = 'stages=SHORTLISTED,INTERVIEW,OFFER,HIRED';

  /** Another application for the same job, at a stage. */
  async function another(jobId: string, stage: ApplicationStage, name: string) {
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    await f.pool.query(
      'INSERT INTO candidates (id,tenant_id,full_name,email) VALUES ($1,$2,$3,$4)',
      [candidateId, f.tenantA, name, `${candidateId}@example.test`],
    );
    await f.pool.query(
      'INSERT INTO applications (id,tenant_id,job_id,candidate_id,stage) VALUES ($1,$2,$3,$4,$5)',
      [applicationId, f.tenantA, jobId, candidateId, stage],
    );
    return { candidateId, applicationId };
  }

  /** A completed AI screening with this fit. */
  async function screened(
    applicationId: string,
    candidateId: string,
    fit: string,
    score: number,
  ) {
    const document = await f.pool.query<{ id: string }>(
      "INSERT INTO candidate_documents(tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256) VALUES($1,$2,$3,'resume.pdf','application/pdf',1,$4) RETURNING id",
      [f.tenantA, candidateId, `${f.tenantA}/${randomUUID()}`, '0'.repeat(64)],
    );
    await f.pool.query(
      `INSERT INTO application_screenings(tenant_id,application_id,document_id,status,trigger,requested_by,criteria,score,fit,missing_must_have,result,started_at,completed_at)
       VALUES($1,$2,$3,'COMPLETED','MANUAL',$4,'[]',$5,$6,false,'{}',now(),now())`,
      [f.tenantA, applicationId, document.rows[0].id, f.adminA.id, score, fit],
    );
  }

  it('lists candidates from shortlisted onward, counting each stage for the tabs', async () => {
    const { jobId, applicationId, candidateId } = await f.scenario();
    await another(jobId, ApplicationStage.INTERVIEW, 'Interview Candidate');
    await another(jobId, ApplicationStage.HIRED, 'Hired Candidate');
    // Not yet shortlisted: the Applications page's, not this one's.
    await another(jobId, ApplicationStage.APPLIED, 'New Applicant');

    const all = await f
      .authorized('get', `/applications?jobId=${jobId}&${scope}&counts=true`)
      .expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.stage_counts).toEqual({
      SHORTLISTED: 1,
      INTERVIEW: 1,
      HIRED: 1,
    });
    expect(
      all.body.data.find((row: { id: string }) => row.id === applicationId),
    ).toMatchObject({
      candidate_name: 'Scenario Candidate',
      candidate_email: `${candidateId}@example.test`,
      job_title: 'Backend Developer',
      stage: 'SHORTLISTED',
    });

    // One tab: its stage only, while the tabs still count them all.
    const tab = await f
      .authorized(
        'get',
        `/applications?jobId=${jobId}&${scope}&stage=INTERVIEW&counts=true`,
      )
      .expect(200);
    expect(tab.body.total).toBe(1);
    expect(tab.body.data[0].candidate_name).toBe('Interview Candidate');
    expect(tab.body.stage_counts).toEqual(all.body.stage_counts);

    // Counted only on request.
    const plain = await f
      .authorized('get', `/applications?jobId=${jobId}&${scope}`)
      .expect(200);
    expect(plain.body.stage_counts).toBeUndefined();
    await f
      .authorized('get', '/applications?stages=SHORTLISTED,BOGUS')
      .expect(400);
  });

  it('filters by the AI screening’s fit', async () => {
    const { jobId, applicationId, candidateId } = await f.scenario();
    const weak = await another(
      jobId,
      ApplicationStage.SHORTLISTED,
      'Weak Match',
    );
    await another(jobId, ApplicationStage.SHORTLISTED, 'Not Screened');
    await screened(applicationId, candidateId, 'STRONG', 88);
    await screened(weak.applicationId, weak.candidateId, 'WEAK', 20);

    const strong = await f
      .authorized('get', `/applications?jobId=${jobId}&${scope}&fit=STRONG`)
      .expect(200);
    expect(strong.body.data).toEqual([
      expect.objectContaining({
        id: applicationId,
        screening_score: 88,
        screening_fit: 'STRONG',
      }),
    ]);
    const notScreened = await f
      .authorized(
        'get',
        `/applications?jobId=${jobId}&${scope}&screening=not_screened`,
      )
      .expect(200);
    expect(
      notScreened.body.data.map(
        (row: { candidate_name: string }) => row.candidate_name,
      ),
    ).toEqual(['Not Screened']);
    await f.authorized('get', '/applications?fit=EXCELLENT').expect(400);
  });

  it('lists the people who can sit on an interview panel', async () => {
    const panel = await f
      .authorized('get', '/interviews/panelists')
      .expect(200);
    expect(panel.body.data).toEqual(
      expect.arrayContaining([
        { id: f.adminA.id, full_name: 'Test User', role: 'HR_ADMIN' },
      ]),
    );
    // Only active people in interview roles, only from this organization.
    const ids = panel.body.data.map((user: { id: string }) => user.id);
    expect(ids).not.toContain(f.employeeA.id);
    expect(ids).not.toContain(f.adminB.id);
    await f
      .authorized('get', '/interviews/panelists', f.employeeToken)
      .expect(403);
  });

  it('shows each candidate’s AI call: whether it was completed, and its score', async () => {
    const { jobId, applicationId } = await f.scenario();
    const planned = await another(
      jobId,
      ApplicationStage.SHORTLISTED,
      'Call Planned',
    );
    const declined = await another(
      jobId,
      ApplicationStage.SHORTLISTED,
      'Call Declined',
    );
    await another(jobId, ApplicationStage.SHORTLISTED, 'Never Called');
    const phone = await f.pool.query<{ id: string }>(
      `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,updated_by)
       VALUES($1,$1,'organization','plivo','production','account_token','enabled','x','****',$2) RETURNING id`,
      [f.tenantA, f.adminA.id],
    );
    const call = async (
      application: string,
      status: string,
      outcome: string | null,
      attempt?: { outcome: string; assessment?: object },
    ) => {
      const request = await f.pool.query<{ id: string }>(
        `INSERT INTO call_requests(tenant_id,application_id,requested_by,language,status,outcome,idempotency_key,completed_at)
         VALUES($1,$2,$3,'EN',$4,$5,$6,CASE WHEN $4='COMPLETED' THEN now() END) RETURNING id`,
        [f.tenantA, application, f.adminA.id, status, outcome, randomUUID()],
      );
      if (attempt)
        await f.pool.query(
          `INSERT INTO call_attempts(tenant_id,call_request_id,number,status,connection_id,outcome,assessment,assessment_status)
           VALUES($1,$2,1,'COMPLETED',$3,$4,$5,$6)`,
          [
            f.tenantA,
            request.rows[0].id,
            phone.rows[0].id,
            attempt.outcome,
            attempt.assessment ? JSON.stringify(attempt.assessment) : null,
            attempt.assessment ? 'COMPLETED' : null,
          ],
        );
    };
    await call(applicationId, 'COMPLETED', 'COMPLETED', {
      outcome: 'COMPLETED',
      assessment: { score: 78, fit: 'GOOD', answers: [] },
    });
    await call(planned.applicationId, 'PLANNED', null);
    await call(declined.applicationId, 'COMPLETED', 'DECLINED', {
      outcome: 'DECLINED',
    });

    const list = await f
      .authorized('get', `/applications?jobId=${jobId}&${scope}`)
      .expect(200);
    const byName = Object.fromEntries(
      list.body.data.map((row: { candidate_name: string }) => [
        row.candidate_name,
        row,
      ]),
    );
    expect(byName['Scenario Candidate']).toMatchObject({
      call_status: 'COMPLETED',
      call_outcome: 'COMPLETED',
      call_completed: true,
      call_assessment_status: 'COMPLETED',
      call_score: 78,
      call_fit: 'GOOD',
    });
    expect(byName['Call Planned']).toMatchObject({
      call_status: 'PLANNED',
      call_completed: false,
      call_score: null,
    });
    // Declining the call isn't completing it.
    expect(byName['Call Declined']).toMatchObject({
      call_outcome: 'DECLINED',
      call_completed: false,
    });
    expect(byName['Never Called']).toMatchObject({
      call_status: null,
      call_completed: false,
    });
  });
});
