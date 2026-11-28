import { JwtService } from '@nestjs/jwt';
import { ApplicationStage, Role } from '../../src/shared/enums';
import { useApiFixture } from '../helpers/api-fixtures';

describe('a job’s hiring team, and what a hiring manager can do', () => {
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

  it('lets an HR Admin build the team; recruiters see it', async () => {
    const { jobId } = await f.scenario();
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const interviewer = await f.user(f.tenantA, Role.INTERVIEWER);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(201);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: interviewer.id, role: 'INTERVIEWER' })
      .expect(201);
    const twice = await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(409);
    expect(twice.body.message).toMatch(/already on this job/);
    // A hiring manager's account can't be added as an interviewer.
    await f
      .authorized('post', `/jobs/${jobId}/assignments`)
      .send({ userId: manager.id, role: 'INTERVIEWER' })
      .expect(404);

    const recruiter = await f.user(f.tenantA, Role.RECRUITER);
    const token = await tokenFor(recruiter);
    const team = await f
      .authorized('get', `/jobs/${jobId}/assignments`, token)
      .expect(200);
    expect(
      team.body.map((a: { role: string; email: string; full_name: string }) => [
        a.role,
        a.email,
        a.full_name,
      ]),
    ).toEqual([
      ['HIRING_MANAGER', manager.email, 'Test User'],
      ['INTERVIEWER', interviewer.email, 'Test User'],
    ]);
    await f
      .authorized('post', `/jobs/${jobId}/assignments`, token)
      .send({ userId: interviewer.id, role: 'INTERVIEWER' })
      .expect(403);
  });

  it('shows a hiring manager their jobs’ applicants and resumes, and lets them shortlist', async () => {
    const mine = await f.scenario();
    const other = await f.scenario();
    await f.pool.query('UPDATE applications SET stage=$2 WHERE id=$1', [
      mine.applicationId,
      ApplicationStage.APPLIED,
    ]);
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    await f
      .authorized('post', `/jobs/${mine.jobId}/assignments`)
      .send({ userId: manager.id, role: 'HIRING_MANAGER' })
      .expect(201);
    const token = await tokenFor(manager);

    const jobs = await f.authorized('get', '/jobs', token).expect(200);
    expect(jobs.body.data.map((j: { id: string }) => j.id)).toEqual([
      mine.jobId,
    ]);
    const applications = await f
      .authorized('get', '/applications', token)
      .expect(200);
    expect(applications.body.data.map((a: { id: string }) => a.id)).toEqual([
      mine.applicationId,
    ]);

    // The resumes of their applicants only.
    await f
      .authorized('get', `/candidates/${mine.candidateId}/documents`, token)
      .expect(200);
    await f
      .authorized('get', `/candidates/${other.candidateId}/documents`, token)
      .expect(404);

    await f
      .authorized('patch', `/applications/${mine.applicationId}/stage`, token)
      .send({ stage: ApplicationStage.SHORTLISTED })
      .expect(200);
    // Interviews and offers stay with recruiters.
    await f
      .authorized('patch', `/applications/${mine.applicationId}/stage`, token)
      .send({ stage: ApplicationStage.INTERVIEW })
      .expect(403);
    await f
      .authorized('get', `/applications/${other.applicationId}`, token)
      .expect(404);
  });
});
