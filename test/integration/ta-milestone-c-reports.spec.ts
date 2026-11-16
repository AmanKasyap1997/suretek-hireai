import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApplicationStage, JobStatus, Role } from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';

describe('Talent acquisition milestone C recruitment reports', () => {
  const f = useApiFixture();
  const from = '2026-01-02T00:00:00.000Z';
  const to = '2026-01-04T00:00:00.000Z';
  const routes = ['funnel', 'time-in-stage', 'time-to-hire'];
  const period = (jobId?: string) =>
    new URLSearchParams({ from, to, ...(jobId ? { jobId } : {}) }).toString();

  async function application(jobId: string, tenantId = f.tenantA) {
    const candidateId = randomUUID();
    const id = randomUUID();
    await f.pool.query(
      "INSERT INTO candidates(id,tenant_id,full_name,email) VALUES($1,$2,'Report applicant',$3)",
      [candidateId, tenantId, `${candidateId}@example.test`],
    );
    await f.pool.query(
      'INSERT INTO applications(id,tenant_id,job_id,candidate_id) VALUES($1,$2,$3,$4)',
      [id, tenantId, jobId, candidateId],
    );
    return id;
  }

  async function events(
    applicationId: string,
    history: Array<[ApplicationStage, string]>,
    tenantId = f.tenantA,
  ) {
    for (let index = 0; index < history.length; index++) {
      const [stage, enteredAt] = history[index];
      await f.pool.query(
        `INSERT INTO application_stage_events(tenant_id,application_id,from_stage,to_stage,actor_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          tenantId,
          applicationId,
          index ? history[index - 1][0] : null,
          stage,
          tenantId === f.tenantA ? f.adminA.id : f.adminB.id,
          enteredAt,
        ],
      );
    }
  }

  async function metricFixture() {
    const { jobId, applicationId } = await f.scenario();
    await events(applicationId, [
      [ApplicationStage.APPLIED, '2026-01-01T00:00:00Z'],
      [ApplicationStage.SHORTLISTED, from],
      [ApplicationStage.INTERVIEW, '2026-01-03T00:00:00Z'],
      [ApplicationStage.HIRED, '2026-01-03T12:00:00Z'],
    ]);
    const second = await application(jobId);
    await events(second, [
      [ApplicationStage.APPLIED, '2026-01-02T06:00:00Z'],
      [ApplicationStage.SHORTLISTED, '2026-01-02T12:00:00Z'],
      [ApplicationStage.INTERVIEW, '2026-01-03T00:00:00Z'],
      [ApplicationStage.SHORTLISTED, '2026-01-03T06:00:00Z'],
      [ApplicationStage.INTERVIEW, '2026-01-03T18:00:00Z'],
    ]);
    return { jobId, applicationId };
  }

  it('counts distinct applications per entered stage, with an inclusive start and exclusive end', async () => {
    const { jobId } = await metricFixture();
    const boundary = await application(jobId);
    await events(boundary, [[ApplicationStage.APPLIED, to]]);
    const response = await f
      .authorized('get', `/reports/recruitment/funnel?${period(jobId)}`)
      .expect(200);
    expect(response.body.period).toEqual({ from, to });
    expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
    expect(response.body.data).toEqual([
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.APPLIED,
        applicationCount: 1,
      },
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.SHORTLISTED,
        applicationCount: 2,
      },
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.INTERVIEW,
        applicationCount: 2,
      },
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.HIRED,
        applicationCount: 1,
      },
    ]);
  });

  it('clips dwell to the period, counts repeated visits and omits terminal dwell', async () => {
    const { jobId } = await metricFixture();
    const response = await f
      .authorized('get', `/reports/recruitment/time-in-stage?${period(jobId)}`)
      .expect(200);
    expect(response.body.data).toEqual([
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.APPLIED,
        applicationCount: 1,
        visitCount: 1,
        totalSeconds: 21600,
        averageSeconds: 21600,
      },
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.SHORTLISTED,
        applicationCount: 2,
        visitCount: 3,
        totalSeconds: 172800,
        averageSeconds: 57600,
      },
      {
        jobId,
        jobTitle: 'Backend Developer',
        stage: ApplicationStage.INTERVIEW,
        applicationCount: 2,
        visitCount: 3,
        totalSeconds: 86400,
        averageSeconds: 28800,
      },
    ]);
  });

  it('measures time to hire from the full history rather than the report start', async () => {
    const { jobId } = await metricFixture();
    const response = await f
      .authorized('get', `/reports/recruitment/time-to-hire?${period(jobId)}`)
      .expect(200);
    expect(response.body.data).toEqual([
      {
        jobId,
        jobTitle: 'Backend Developer',
        hireCount: 1,
        totalSeconds: 216000,
        averageSeconds: 216000,
        minSeconds: 216000,
        maxSeconds: 216000,
      },
    ]);
    expect(response.body.excludedHiresMissingApplied).toBe(0);
    expect(response.body.excludedHiresInvalidOrder).toBe(0);
  });

  it('reports missing and reversed applied evidence without inventing hire durations', async () => {
    const { jobId, applicationId } = await f.scenario();
    await events(applicationId, [[ApplicationStage.HIRED, from]]);
    const reversed = await application(jobId);
    await events(reversed, [
      [ApplicationStage.HIRED, '2026-01-02T12:00:00Z'],
      [ApplicationStage.APPLIED, '2026-01-03T00:00:00Z'],
    ]);
    const response = await f
      .authorized('get', `/reports/recruitment/time-to-hire?${period(jobId)}`)
      .expect(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.excludedHiresMissingApplied).toBe(1);
    expect(response.body.excludedHiresInvalidOrder).toBe(1);
  });

  it('caps open-stage duration at asOf when the requested period extends into the future', async () => {
    const { jobId, applicationId } = await f.scenario();
    const enteredAt = new Date(Date.now() - 3600000).toISOString();
    await events(applicationId, [[ApplicationStage.APPLIED, enteredAt]]);
    const query = new URLSearchParams({
      jobId,
      from: enteredAt,
      to: new Date(Date.now() + 86400000).toISOString(),
    });
    const response = await f
      .authorized('get', `/reports/recruitment/time-in-stage?${query}`)
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].stage).toBe(ApplicationStage.APPLIED);
    const observedSeconds =
      (Date.parse(response.body.asOf) - Date.parse(enteredAt)) / 1000;
    expect(response.body.data[0].totalSeconds).toBeCloseTo(observedSeconds, 3);
    expect(response.body.data[0].totalSeconds).toBeLessThan(3700);
  });

  it('keeps every report tenant scoped and restricts report access to recruitment staff', async () => {
    const { jobId } = await metricFixture();
    const otherJobId = randomUUID();
    await f.pool.query(
      `INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by)
       VALUES($1,$2,'Other tenant report job','Reporting fixture','Engineering','Remote',$3,$4)`,
      [otherJobId, f.tenantB, JobStatus.PUBLISHED, f.adminB.id],
    );
    const otherApplication = await application(otherJobId, f.tenantB);
    await events(
      otherApplication,
      [[ApplicationStage.APPLIED, from]],
      f.tenantB,
    );
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const interviewer = await f.user(f.tenantA, Role.INTERVIEWER);
    const recruiter = await f.user(f.tenantA, Role.RECRUITER);
    const managerToken = await f.app!.get(JwtService).signAsync(
      { sub: manager.id, tenantId: f.tenantA },
      {
        expiresIn: 900,
        algorithm: 'HS256',
        issuer: 'suretek-hireai',
        audience: 'suretek-api',
      },
    );
    const sign = (user: { id: string; tenantId: string }) =>
      f.app!.get(JwtService).signAsync(
        { sub: user.id, tenantId: user.tenantId },
        {
          expiresIn: 900,
          algorithm: 'HS256',
          issuer: 'suretek-hireai',
          audience: 'suretek-api',
        },
      );
    const interviewerToken = await sign(interviewer);
    const recruiterToken = await sign(recruiter);
    for (const route of routes) {
      await request(f.app!.getHttpServer())
        .get(`${api}/reports/recruitment/${route}`)
        .expect(401);
      await f
        .authorized('get', `/reports/recruitment/${route}`, f.employeeToken)
        .expect(403);
      await f
        .authorized('get', `/reports/recruitment/${route}`, managerToken)
        .expect(403);
      await f
        .authorized('get', `/reports/recruitment/${route}`, interviewerToken)
        .expect(403);
      await f
        .authorized(
          'get',
          `/reports/recruitment/${route}?${period(jobId)}`,
          recruiterToken,
        )
        .expect(200);
      await f
        .authorized(
          'get',
          `/reports/recruitment/${route}?${period(jobId)}`,
          f.tokenB,
        )
        .expect(404);
      const own = await f
        .authorized(
          'get',
          `/reports/recruitment/${route}?${period()}`,
          f.tokenB,
        )
        .expect(200);
      expect(
        own.body.data.every(
          (row: { jobId: string }) => row.jobId === otherJobId,
        ),
      ).toBe(true);
      expect(JSON.stringify(own.body)).not.toContain(jobId);
    }
  });

  it('validates report filters, rejects unknown jobs and defaults to a bounded thirty-day period', async () => {
    for (const route of routes) {
      for (const invalid of [
        'from=bad',
        'from=2026-01-03T00:00:00Z&to=2026-01-02T00:00:00Z',
        'from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z',
        'sort=unsafe',
        'jobId=not-uuid',
      ])
        await f
          .authorized('get', `/reports/recruitment/${route}?${invalid}`)
          .expect(400);
      await f
        .authorized(
          'get',
          `/reports/recruitment/${route}?jobId=${randomUUID()}`,
        )
        .expect(404);
      const response = await f
        .authorized('get', `/reports/recruitment/${route}`)
        .expect(200);
      expect(
        Date.parse(response.body.period.to) -
          Date.parse(response.body.period.from),
      ).toBe(30 * 86400000);
      expect(response.body.period.to).toBe(response.body.asOf);
    }
  });
});
