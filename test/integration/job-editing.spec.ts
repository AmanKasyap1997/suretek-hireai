import { JwtService } from '@nestjs/jwt';
import { Role } from '../../src/shared/enums';
import request from 'supertest';
import { api, useApiFixture } from '../helpers/api-fixtures';

describe('editing a job after it is published', () => {
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
  const input = {
    title: 'Laravel Developer',
    description: 'Build and run our recruitment APIs in Laravel.',
    department: 'Engineering',
    location: 'Noida',
    openings: 2,
    employmentType: 'FULL_TIME',
    salaryMin: 600000,
    salaryMax: 900000,
    screeningCriteria: [
      { id: 'php', label: 'PHP and Laravel', weight: 60, must_have: true },
    ],
  };
  const question = (id: string, text: string) => ({
    id,
    text,
    answer_type: 'yes_no',
    expected_answer: 'yes',
    criterion_id: null,
    key_points: [],
  });

  /** A job an HR Admin approved and published. */
  async function published() {
    const job = await f.authorized('post', '/jobs').send(input).expect(201);
    await f.authorized('post', `/jobs/${job.body.id}/approve`).expect(200);
    await f.authorized('post', `/jobs/${job.body.id}/publish`).expect(200);
    return job.body.id as string;
  }

  it('lets an HR Admin change a published job, questions and details alike', async () => {
    const id = await published();
    const edited = await f
      .authorized('patch', `/jobs/${id}`)
      .send({
        ...input,
        description: 'Build and run our recruitment APIs in Laravel and Vue.',
        salaryMax: 1000000,
        callQuestions: [
          question('q-office', 'Can you work from our Noida office?'),
          question('q-notice', 'Can you join within 30 days?'),
        ],
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      status: 'PUBLISHED',
      description: 'Build and run our recruitment APIs in Laravel and Vue.',
    });
    expect(Number(edited.body.salary_max)).toBe(1000000);
    expect(edited.body.call_questions).toHaveLength(2);
    // The audit log says what changed, and that the job was live.
    const audit = await f.pool.query(
      "SELECT metadata FROM audit_events WHERE entity_id=$1 AND action='job.updated'",
      [id],
    );
    expect(audit.rows[0].metadata.status).toBe('PUBLISHED');
    expect([...audit.rows[0].metadata.fields].sort()).toEqual([
      'callQuestions',
      'description',
      'salaryMax',
    ]);
  });

  it('lets a recruiter add questions and criteria, but not change what candidates see', async () => {
    const id = await published();
    const recruiter = await f.user(f.tenantA, Role.RECRUITER);
    const token = await tokenFor(recruiter);
    // The whole form, details unchanged: fine.
    await f
      .authorized('patch', `/jobs/${id}`, token)
      .send({
        ...input,
        screeningCriteria: [
          ...input.screeningCriteria,
          { id: 'vue', label: 'Vue.js', weight: 40, must_have: false },
        ],
        autoScreen: false,
        callQuestions: [question('q-office', 'Can you work from Noida?')],
      })
      .expect(200);
    const refused = await f
      .authorized('patch', `/jobs/${id}`, token)
      .send({ title: 'Senior Laravel Developer' })
      .expect(403);
    expect(refused.body.message).toMatch(/Only an HR Admin can change/);
    const job = await f.authorized('get', `/jobs/${id}`).expect(200);
    expect(job.body).toMatchObject({
      title: 'Laravel Developer',
      auto_screen: false,
    });
    expect(job.body.screening_criteria).toHaveLength(2);
  });

  it('keeps recruiters off a job until an HR Admin approves it', async () => {
    const recruiter = await f.user(f.tenantA, Role.RECRUITER);
    const token = await tokenFor(recruiter);
    // Hiring managers request jobs; recruiters don't create them.
    await f.authorized('post', '/jobs', token).send(input).expect(403);
    const draft = await f.authorized('post', '/jobs').send(input).expect(201);
    const refused = await f
      .authorized('patch', `/jobs/${draft.body.id}`, token)
      .send({ autoScreen: false })
      .expect(409);
    expect(refused.body.message).toBe(
      'A recruiter works on this job once an HR Admin approves it.',
    );
    await request(f.app!.getHttpServer())
      .put(`${api}/jobs/${draft.body.id}/interview-setup`)
      .auth(token, { type: 'bearer' })
      .send({ interviewSetup: null })
      .expect(409);
    // Approved: theirs to prepare and publish.
    await f.authorized('post', `/jobs/${draft.body.id}/approve`).expect(200);
    await f
      .authorized('patch', `/jobs/${draft.body.id}`, token)
      .send({ autoScreen: false })
      .expect(200);
  });

  it('doesn’t edit a closed job', async () => {
    const id = await published();
    await f
      .authorized('post', `/jobs/${id}/close`)
      .send({ closeReason: 'Filled' })
      .expect(200);
    const refused = await f
      .authorized('patch', `/jobs/${id}`)
      .send({ autoScreen: false })
      .expect(409);
    expect(refused.body.message).toBe('Closed jobs can’t be edited.');
  });
});
