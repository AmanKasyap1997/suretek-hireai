import { JwtService } from '@nestjs/jwt';
import { Role } from '../../src/shared/enums';
import { useApiFixture } from '../helpers/api-fixtures';

describe('a hiring manager requests a job, an HR Admin approves it, a recruiter publishes it', () => {
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
  const request = {
    title: 'Data Analyst',
    description: 'Turn hiring data into weekly decisions for the team.',
    department: 'Analytics',
    location: 'Noida',
    openings: 1,
    screeningCriteria: [
      { id: 'sql', label: 'SQL', weight: 60, must_have: true },
    ],
  };

  it('goes from request to approval (after one send-back) to publishing', async () => {
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const recruiter = await f.user(f.tenantA, Role.RECRUITER);
    const hm = await tokenFor(manager);
    const rec = await tokenFor(recruiter);

    // The hiring manager drafts the request, and is on its hiring team.
    const job = await f
      .authorized('post', '/jobs', hm)
      .send(request)
      .expect(201);
    expect(job.body).toMatchObject({ status: 'DRAFT', requested_at: null });
    const id = job.body.id as string;
    const team = await f
      .authorized('get', `/jobs/${id}/assignments`)
      .expect(200);
    expect(team.body).toEqual([
      expect.objectContaining({ user_id: manager.id, role: 'HIRING_MANAGER' }),
    ]);
    await f
      .authorized('patch', `/jobs/${id}`, hm)
      .send({ openings: 2 })
      .expect(200);

    // Submitted: the HR Admin sees it awaiting approval, with who asked.
    const submitted = await f
      .authorized('post', `/jobs/${id}/submit`, hm)
      .expect(200);
    expect(submitted.body.requested_at).not.toBeNull();
    const awaiting = await f
      .authorized('get', '/jobs?awaiting=approval')
      .expect(200);
    expect(awaiting.body.data).toEqual([
      expect.objectContaining({ id, created_by_name: 'Test User' }),
    ]);
    // Recruiters wait for approval; only an HR Admin approves or sends back.
    await f
      .authorized('patch', `/jobs/${id}`, rec)
      .send({ openings: 5 })
      .expect(409);
    await f.authorized('post', `/jobs/${id}/submit`, rec).expect(403);
    await f.authorized('post', `/jobs/${id}/approve`, rec).expect(403);
    await f
      .authorized('post', `/jobs/${id}/send-back`, rec)
      .send({ note: 'x' })
      .expect(403);

    // Sent back with a note; changed and submitted again.
    const back = await f
      .authorized('post', `/jobs/${id}/send-back`)
      .send({ note: 'Add the salary range, please.' })
      .expect(200);
    expect(back.body).toMatchObject({
      requested_at: null,
      review_note: 'Add the salary range, please.',
    });
    await f
      .authorized('post', `/jobs/${id}/send-back`)
      .send({ note: 'Again' })
      .expect(409);
    await f
      .authorized('patch', `/jobs/${id}`, hm)
      .send({ salaryMin: 800000, salaryMax: 1200000 })
      .expect(200);
    await f.authorized('post', `/jobs/${id}/submit`, hm).expect(200);

    // Approved: the note goes, and the hiring manager can't change it now.
    const approved = await f
      .authorized('post', `/jobs/${id}/approve`)
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED',
      review_note: null,
    });
    await f
      .authorized('patch', `/jobs/${id}`, hm)
      .send({ openings: 3 })
      .expect(409);
    await f.authorized('post', `/jobs/${id}/publish`, hm).expect(403);

    // The recruiter adds call questions, sees the channels and publishes.
    await f
      .authorized('patch', `/jobs/${id}`, rec)
      .send({
        callQuestions: [
          {
            id: 'q1',
            text: 'Can you work from our Noida office?',
            answer_type: 'yes_no',
            expected_answer: 'yes',
          },
        ],
      })
      .expect(200);
    await f.authorized('get', '/jobs/publishing/channels', rec).expect(200);
    const published = await f
      .authorized('post', `/jobs/${id}/publish`, rec)
      .expect(200);
    expect(published.body.status).toBe('PUBLISHED');

    const audit = await f.pool.query(
      "SELECT action FROM audit_events WHERE entity_id=$1 AND action LIKE 'job.%' ORDER BY created_at,id",
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'job.created',
      'job.updated',
      'job.submitted',
      'job.sent_back',
      'job.updated',
      'job.submitted',
      'job.approved',
      'job.updated',
      'job.published',
    ]);
  });

  it('lets a hiring manager write the AI call questions, and try them on their own jobs', async () => {
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const other = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const hm = await tokenFor(manager);
    await f.authorized('get', '/jobs/call-questions/settings', hm).expect(200);
    const question = {
      id: 'q1',
      text: 'Have you built dashboards in Power BI?',
      answer_type: 'yes_no',
      expected_answer: 'yes',
    };
    const job = await f
      .authorized('post', '/jobs', hm)
      .send({ ...request, callQuestions: [question] })
      .expect(201);
    expect(job.body.call_questions).toEqual([
      expect.objectContaining({ id: 'q1', text: question.text }),
    ]);
    // A test call gets past the job check (then stops: no voice AI here).
    const tried = await f
      .authorized('post', '/calls/test-sessions', hm)
      .send({ jobId: job.body.id, language: 'EN' })
      .expect(409);
    expect(tried.body.message).not.toMatch(/Job not found/);
    await f
      .authorized('post', '/calls/test-sessions', await tokenFor(other))
      .send({ jobId: job.body.id, language: 'EN' })
      .expect(404);
  });

  it('shows a hiring manager only their own requests', async () => {
    const one = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const other = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const job = await f
      .authorized('post', '/jobs', await tokenFor(one))
      .send(request)
      .expect(201);
    const token = await tokenFor(other);
    const list = await f.authorized('get', '/jobs', token).expect(200);
    expect(list.body.data.map((j: { id: string }) => j.id)).not.toContain(
      job.body.id,
    );
    await f
      .authorized('patch', `/jobs/${job.body.id}`, token)
      .send({ openings: 4 })
      .expect(404);
    await f
      .authorized('post', `/jobs/${job.body.id}/submit`, token)
      .expect(404);
  });
});
