import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CalendarPort, DisabledCalendar } from '../../src/integrations';
import { DbService } from '../../src/platform/database/db.service';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import {
  ApplicationStage,
  AssignmentRole,
  InterviewMode,
  InterviewStatus,
  JobStatus,
  Role,
  ScorecardRecommendation,
} from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';

const criteria = [
  {
    id: 'experience',
    label: 'Relevant experience',
    weight: 70,
    must_have: true,
  },
  { id: 'communication', label: 'Communication', weight: 30, must_have: false },
];
const card = {
  scores: [
    { criterionId: 'experience', score: 0 },
    { criterionId: 'communication', score: 5 },
  ],
  recommendation: ScorecardRecommendation.NO_HIRE,
  notes: 'Human interview evidence, without an automated decision.',
};

describe('Talent acquisition milestone C interviews and scorecards', () => {
  const f = useApiFixture();
  let slotNumber = 0;
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
  function slot() {
    const start =
      Date.parse('2030-01-01T00:00:00Z') + slotNumber++ * 6 * 3600000;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 3600000).toISOString(),
    };
  }
  const input = (
    applicationId: string,
    panelistIds: string[],
    time = slot(),
  ) => ({
    applicationId,
    round: 'Technical interview',
    mode: InterviewMode.VIDEO,
    ...time,
    meetingUrl: 'https://meet.example.test/interview',
    panelistIds,
  });
  async function schedule(
    panelistIds = [f.adminA.id],
    screeningCriteria = criteria,
  ) {
    const context = await f.scenario();
    await f.pool.query('UPDATE jobs SET screening_criteria=$2 WHERE id=$1', [
      context.jobId,
      JSON.stringify(screeningCriteria),
    ]);
    const body = input(context.applicationId, panelistIds);
    const response = await f
      .authorized('post', '/interviews')
      .send(body)
      .expect(201);
    return { ...context, body, interview: response.body };
  }

  it('schedules a local interview with its criteria snapshot and active panel, without changing the application stage', async () => {
    const panelist = await f.user(f.tenantA, Role.INTERVIEWER);
    const scheduled = await schedule([panelist.id, f.adminA.id]);
    expect(scheduled.interview).toEqual(
      expect.objectContaining({
        application_id: scheduled.applicationId,
        round: scheduled.body.round,
        mode: InterviewMode.VIDEO,
        status: InterviewStatus.SCHEDULED,
        starts_at: scheduled.body.startsAt,
        ends_at: scheduled.body.endsAt,
        criteria_snapshot: criteria,
        panelist_ids: [panelist.id, f.adminA.id].sort(),
      }),
    );
    const list = await f
      .authorized(
        'get',
        `/interviews?applicationId=${scheduled.applicationId}&status=${InterviewStatus.SCHEDULED}&offset=100`,
      )
      .expect(200);
    expect(list.body).toEqual({
      data: [],
      pagination: { limit: 25, offset: 100 },
      total: 1,
    });
    const state = await f.pool.query(
      'SELECT stage FROM applications WHERE id=$1',
      [scheduled.applicationId],
    );
    expect(state.rows[0].stage).toBe(ApplicationStage.SHORTLISTED);
    const audit = await f.pool.query(
      "SELECT action FROM audit_events WHERE entity_id=$1 AND action='interview.created'",
      [scheduled.interview.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('requires actual panel membership for scoped interview reads, independently of job assignments', async () => {
    const member = await f.user(f.tenantA, Role.INTERVIEWER);
    const manager = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const scheduled = await schedule([member.id]);
    const memberToken = await tokenFor(member);
    const managerToken = await tokenFor(manager);
    await f.pool.query(
      'INSERT INTO job_assignments(tenant_id,job_id,user_id,role) VALUES($1,$2,$3,$4)',
      [f.tenantA, scheduled.jobId, manager.id, AssignmentRole.HIRING_MANAGER],
    );
    await f
      .authorized('get', `/interviews/${scheduled.interview.id}`, memberToken)
      .expect(200);
    await f
      .authorized('get', `/interviews/${scheduled.interview.id}`, managerToken)
      .expect(404);
    const hidden = await f
      .authorized('get', '/interviews', managerToken)
      .expect(200);
    expect(hidden.body.data).toEqual([]);
    expect(hidden.body.total).toBe(0);
    const own = await f
      .authorized('get', '/interviews', memberToken)
      .expect(200);
    expect(own.body.data.map((row: { id: string }) => row.id)).toEqual([
      scheduled.interview.id,
    ]);
    await f
      .authorized('post', '/interviews', memberToken)
      .send(scheduled.body)
      .expect(403);
    await f
      .authorized('patch', `/interviews/${scheduled.interview.id}`, memberToken)
      .send({ location: 'Changed' })
      .expect(403);
    await f
      .authorized(
        'post',
        `/interviews/${scheduled.interview.id}/cancel`,
        memberToken,
      )
      .send({ reason: 'Denied' })
      .expect(403);
  });

  it('denies unauthorized roles and hides every interview and scorecard endpoint across tenants', async () => {
    const scheduled = await schedule();
    const paths: Array<['get' | 'post' | 'patch', string, object?]> = [
      ['get', '/interviews'],
      ['post', '/interviews', scheduled.body],
      ['get', `/interviews/${scheduled.interview.id}`],
      ['patch', `/interviews/${scheduled.interview.id}`, { ...slot() }],
      [
        'post',
        `/interviews/${scheduled.interview.id}/cancel`,
        { reason: 'Denied' },
      ],
      ['get', `/interviews/${scheduled.interview.id}/scorecards`],
      ['post', `/interviews/${scheduled.interview.id}/scorecards`, card],
    ];
    for (const [method, path, body] of paths) {
      const unauthenticated = request(f.app!.getHttpServer())[method](
        `${api}${path}`,
      );
      if (body) unauthenticated.send(body);
      await unauthenticated.expect(401);
      const employee = f.authorized(method, path, f.employeeToken);
      if (body) employee.send(body);
      await employee.expect(403);
      if (path === '/interviews' && method === 'get') {
        const list = await f.authorized(method, path, f.tokenB).expect(200);
        expect(list.body.data).toEqual([]);
        expect(list.body.total).toBe(0);
      } else {
        const foreign = f.authorized(method, path, f.tokenB);
        if (body) foreign.send(body);
        await foreign.expect(404);
      }
    }
  });

  it('validates schedule, venue and panel inputs and refuses unavailable panelists or ineligible applications', async () => {
    const context = await f.scenario();
    const body = input(context.applicationId, [f.adminA.id]);
    for (const change of [
      { endsAt: body.startsAt },
      { startsAt: '2020-01-01T10:00:00Z', endsAt: '2020-01-01T11:00:00Z' },
      {
        endsAt: new Date(
          Date.parse(body.startsAt) + 25 * 3600000,
        ).toISOString(),
      },
      { meetingUrl: null },
      { meetingUrl: 'not-a-url' },
      { meetingUrl: 'http://meet.example.test' },
      { meetingUrl: `https://meet.example.test/${'x'.repeat(2000)}` },
      { mode: InterviewMode.ONSITE, meetingUrl: null, location: null },
      { panelistIds: [] },
      { panelistIds: [f.adminA.id, f.adminA.id] },
      { tenantId: f.tenantB },
    ])
      await f
        .authorized('post', '/interviews')
        .send({ ...body, ...change })
        .expect(400);
    const inactive = await f.user(f.tenantA, Role.INTERVIEWER);
    await f.pool.query('UPDATE users SET active=false WHERE id=$1', [
      inactive.id,
    ]);
    for (const panelistId of [f.adminB.id, f.employeeA.id, inactive.id]) {
      await f
        .authorized('post', '/interviews')
        .send({ ...body, panelistIds: [panelistId] })
        .expect(404);
    }
    for (const stage of [
      ApplicationStage.APPLIED,
      ApplicationStage.REJECTED,
      ApplicationStage.HIRED,
    ]) {
      await f.pool.query('UPDATE applications SET stage=$2 WHERE id=$1', [
        context.applicationId,
        stage,
      ]);
      await f.authorized('post', '/interviews').send(body).expect(409);
    }
    await f.pool.query('UPDATE applications SET stage=$2 WHERE id=$1', [
      context.applicationId,
      ApplicationStage.INTERVIEW,
    ]);
    await f.pool.query('UPDATE candidates SET erased_at=now() WHERE id=$1', [
      context.candidateId,
    ]);
    await f.authorized('post', '/interviews').send(body).expect(404);
  });

  it('serializes overlapping concurrent bookings, allows adjacency and frees the slot on idempotent cancellation', async () => {
    const context = await f.scenario();
    const panelist = await f.user(f.tenantA, Role.INTERVIEWER);
    const body = input(context.applicationId, [panelist.id]);
    const results = await Promise.all([
      f.authorized('post', '/interviews').send(body),
      f
        .authorized('post', '/interviews')
        .send({ ...body, round: 'Concurrent attempt' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const created = results.find((result) => result.status === 201)!.body;
    expect(
      (
        await f.pool.query(
          'SELECT id FROM interviews WHERE application_id=$1',
          [context.applicationId],
        )
      ).rows,
    ).toHaveLength(1);
    const adjacent = {
      startsAt: body.endsAt,
      endsAt: new Date(Date.parse(body.endsAt) + 3600000).toISOString(),
    };
    await f
      .authorized('post', '/interviews')
      .send(input(context.applicationId, [panelist.id], adjacent))
      .expect(201);
    for (let attempt = 0; attempt < 2; attempt++) {
      const cancelled = await f
        .authorized('post', `/interviews/${created.id}/cancel`)
        .send({ reason: 'Rescheduled by recruiter' })
        .expect(200);
      expect(cancelled.body.status).toBe(InterviewStatus.CANCELLED);
    }
    expect(
      (
        await f.pool.query(
          "SELECT id FROM audit_events WHERE entity_id=$1 AND action='interview.cancelled'",
          [created.id],
        )
      ).rows,
    ).toHaveLength(1);
    await f.authorized('post', '/interviews').send(body).expect(201);
    await f
      .authorized('patch', `/interviews/${created.id}`)
      .send(slot())
      .expect(409);
  });

  it('rolls back a conflicting reschedule and can replace the conflicting panel atomically', async () => {
    const firstPanelist = await f.user(f.tenantA, Role.INTERVIEWER);
    const replacement = await f.user(f.tenantA, Role.INTERVIEWER);
    const first = await schedule([firstPanelist.id]);
    const second = await schedule([firstPanelist.id]);
    const conflictingTime = {
      startsAt: first.body.startsAt,
      endsAt: first.body.endsAt,
    };
    await f
      .authorized('patch', `/interviews/${second.interview.id}`)
      .send(conflictingTime)
      .expect(409);
    const unchanged = await f
      .authorized('get', `/interviews/${second.interview.id}`)
      .expect(200);
    expect(unchanged.body.starts_at).toBe(second.body.startsAt);
    expect(unchanged.body.panelist_ids).toEqual([firstPanelist.id]);
    const changed = await f
      .authorized('patch', `/interviews/${second.interview.id}`)
      .send({ ...conflictingTime, panelistIds: [replacement.id] })
      .expect(200);
    expect(changed.body.starts_at).toBe(first.body.startsAt);
    expect(changed.body.panelist_ids).toEqual([replacement.id]);
    const reservation = await f.pool.query(
      'SELECT user_id,starts_at,ends_at,status FROM interview_panelists WHERE interview_id=$1',
      [second.interview.id],
    );
    expect(reservation.rows).toEqual([
      {
        user_id: replacement.id,
        starts_at: new Date(first.body.startsAt),
        ends_at: new Date(first.body.endsAt),
        status: InterviewStatus.SCHEDULED,
      },
    ]);
    await f
      .authorized('patch', `/interviews/${second.interview.id}`)
      .send({ startsAt: first.body.startsAt })
      .expect(400);
  });

  it('uses the original criteria snapshot after job edits and records evidence without deciding an outcome', async () => {
    const scheduled = await schedule();
    await f.pool.query('UPDATE jobs SET screening_criteria=$2 WHERE id=$1', [
      scheduled.jobId,
      JSON.stringify([
        {
          id: 'new',
          label: 'Changed requirement',
          weight: 100,
          must_have: true,
        },
      ]),
    ]);
    const changed = await f
      .authorized('patch', `/interviews/${scheduled.interview.id}`)
      .send(slot())
      .expect(200);
    expect(changed.body.criteria_snapshot).toEqual(criteria);
    await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send({ ...card, scores: [{ criterionId: 'new', score: 5 }] })
      .expect(400);
    const submitted = await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send(card)
      .expect(201);
    expect(submitted.body).toEqual(
      expect.objectContaining({
        scores: card.scores,
        recommendation: ScorecardRecommendation.NO_HIRE,
        panelist_user_id: f.adminA.id,
      }),
    );
    expect(submitted.body.tenant_id).toBeUndefined();
    expect(
      (
        await f.pool.query('SELECT stage FROM applications WHERE id=$1', [
          scheduled.applicationId,
        ])
      ).rows[0].stage,
    ).toBe(ApplicationStage.SHORTLISTED);
    expect(
      (
        await f.pool.query('SELECT status FROM interviews WHERE id=$1', [
          scheduled.interview.id,
        ])
      ).rows[0].status,
    ).toBe(InterviewStatus.SCHEDULED);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM application_stage_events WHERE application_id=$1',
          [scheduled.applicationId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM audit_events WHERE entity_id=$1 AND action='scorecard.submitted'",
          [submitted.body.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('validates an exact criterion set with integral scores from zero through five', async () => {
    const scheduled = await schedule();
    for (const scores of [
      [],
      [card.scores[0]],
      [...card.scores, { criterionId: 'unknown', score: 3 }],
      [card.scores[0], card.scores[0]],
      [{ criterionId: 'experience', score: -1 }, card.scores[1]],
      [{ criterionId: 'experience', score: 6 }, card.scores[1]],
      [{ criterionId: 'experience', score: 1.5 }, card.scores[1]],
    ])
      await f
        .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
        .send({ ...card, scores })
        .expect(400);
    await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send({ ...card, notes: 'x'.repeat(5001) })
      .expect(400);
    const result = await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send(card)
      .expect(201);
    expect(
      result.body.scores.map((score: { score: number }) => score.score),
    ).toEqual([0, 5]);
    const empty = await schedule([f.adminA.id], []);
    await f
      .authorized('post', `/interviews/${empty.interview.id}/scorecards`)
      .send({ scores: [], recommendation: ScorecardRecommendation.HOLD })
      .expect(201);
  });

  it('limits scoped scorecard visibility to the submitting panelist and refuses nonpanel submissions even by staff', async () => {
    const first = await f.user(f.tenantA, Role.INTERVIEWER);
    const second = await f.user(f.tenantA, Role.HIRING_MANAGER);
    const outsider = await f.user(f.tenantA, Role.INTERVIEWER);
    const tokens = await Promise.all([
      tokenFor(first),
      tokenFor(second),
      tokenFor(outsider),
    ]);
    const scheduled = await schedule([first.id, second.id]);
    await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send(card)
      .expect(404);
    await f
      .authorized(
        'post',
        `/interviews/${scheduled.interview.id}/scorecards`,
        tokens[2],
      )
      .send(card)
      .expect(404);
    await f
      .authorized(
        'get',
        `/interviews/${scheduled.interview.id}/scorecards`,
        tokens[2],
      )
      .expect(404);
    for (const token of tokens.slice(0, 2))
      await f
        .authorized(
          'post',
          `/interviews/${scheduled.interview.id}/scorecards`,
          token,
        )
        .send(card)
        .expect(201);
    const staff = await f
      .authorized('get', `/interviews/${scheduled.interview.id}/scorecards`)
      .expect(200);
    expect(staff.body).toHaveLength(2);
    for (const [index, token] of tokens.slice(0, 2).entries()) {
      const own = await f
        .authorized(
          'get',
          `/interviews/${scheduled.interview.id}/scorecards`,
          token,
        )
        .expect(200);
      expect(own.body).toHaveLength(1);
      expect(own.body[0].panelist_user_id).toBe(index ? second.id : first.id);
    }
    await f
      .authorized('patch', `/interviews/${scheduled.interview.id}`)
      .send({ panelistIds: [second.id] })
      .expect(409);
  });

  it('serializes duplicate scorecard submissions and retains immutable evidence after cancellation', async () => {
    const scheduled = await schedule();
    const results = await Promise.all([
      f
        .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
        .send(card),
      f
        .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
        .send(card),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const saved = results.find((result) => result.status === 201)!.body;
    await f
      .authorized('post', `/interviews/${scheduled.interview.id}/cancel`)
      .send({ reason: 'Keep interview evidence' })
      .expect(200);
    const list = await f
      .authorized('get', `/interviews/${scheduled.interview.id}/scorecards`)
      .expect(200);
    expect(list.body).toEqual([saved]);
    await f
      .authorized('post', `/interviews/${scheduled.interview.id}/scorecards`)
      .send(card)
      .expect(409);
    await f
      .authorized(
        'patch',
        `/interviews/${scheduled.interview.id}/scorecards/${saved.id}`,
      )
      .send({ notes: 'Tampered' })
      .expect(404);
    await f
      .authorized(
        'delete',
        `/interviews/${scheduled.interview.id}/scorecards/${saved.id}`,
      )
      .expect(404);
  });

  it('resolves the disabled calendar boundary without making a network request', async () => {
    const calendar = f.app!.get(CalendarPort);
    expect(calendar).toBeInstanceOf(DisabledCalendar);
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Calendar must remain offline'));
    try {
      await expect(
        calendar.schedule({
          tenantId: f.tenantA,
          interviewId: randomUUID(),
          title: 'Local only',
          ...slot(),
          panelistIds: [f.adminA.id],
        }),
      ).resolves.toEqual({ status: 'disabled' });
      await expect(calendar.cancel(f.tenantA, randomUUID())).resolves.toEqual({
        status: 'disabled',
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('enforces forced RLS, composite references and append-only scorecards for every new table', async () => {
    const own = await schedule([f.adminA.id], []);
    const ownCard = await f
      .authorized('post', `/interviews/${own.interview.id}/scorecards`)
      .send({ scores: [], recommendation: ScorecardRecommendation.HOLD })
      .expect(201);
    const otherUser = await f.user(f.tenantB, Role.INTERVIEWER);
    const other = {
      candidateId: randomUUID(),
      jobId: randomUUID(),
      applicationId: randomUUID(),
      interviewId: randomUUID(),
      panelId: randomUUID(),
      cardId: randomUUID(),
    };
    await f.pool.query(
      "INSERT INTO candidates(id,tenant_id,full_name,email) VALUES($1,$2,'Foreign interview applicant',$3)",
      [other.candidateId, f.tenantB, `${other.candidateId}@example.test`],
    );
    await f.pool.query(
      "INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by) VALUES($1,$2,'Foreign job','Interview fixture','Engineering','Remote',$3,$4)",
      [other.jobId, f.tenantB, JobStatus.PUBLISHED, f.adminB.id],
    );
    await f.pool.query(
      'INSERT INTO applications(id,tenant_id,job_id,candidate_id,stage) VALUES($1,$2,$3,$4,$5)',
      [
        other.applicationId,
        f.tenantB,
        other.jobId,
        other.candidateId,
        ApplicationStage.SHORTLISTED,
      ],
    );
    const time = slot();
    await f.pool.query(
      "INSERT INTO interviews(id,tenant_id,application_id,round,mode,starts_at,ends_at,created_by) VALUES($1,$2,$3,'Foreign round',$4,$5,$6,$7)",
      [
        other.interviewId,
        f.tenantB,
        other.applicationId,
        InterviewMode.PHONE,
        time.startsAt,
        time.endsAt,
        f.adminB.id,
      ],
    );
    await f.pool.query(
      'INSERT INTO interview_panelists(id,tenant_id,interview_id,user_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$5,$6)',
      [
        other.panelId,
        f.tenantB,
        other.interviewId,
        f.adminB.id,
        time.startsAt,
        time.endsAt,
        randomUUID(),
        otherUser.id,
      ],
    );
    await f.pool.query(
      'INSERT INTO interview_scorecards(id,tenant_id,interview_id,panelist_user_id,scores,recommendation) VALUES($1,$2,$3,$4,$5,$6)',
      [
        other.cardId,
        f.tenantB,
        other.interviewId,
        f.adminB.id,
        '[]',
        ScorecardRecommendation.HOLD,
      ],
    );
    const runtime = f.app!.get(DbService);
    for (const [table, foreignId] of [
      ['interviews', other.interviewId],
      ['interview_panelists', other.panelId],
      ['interview_scorecards', other.cardId],
    ]) {
      const guard = await f.pool.query(
        `SELECT relrowsecurity,relforcerowsecurity,EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation') AS policy FROM pg_class c WHERE c.oid=$1::regclass`,
        [table],
      );
      expect(guard.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policy: true,
      });
      expect(await runtime.query(`SELECT id FROM ${table}`)).toEqual([]);
      const visible = await runWithTenant(f.tenantA, () =>
        runtime.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((row) => row.tenant_id === f.tenantA)).toBe(true);
      expect(
        await runWithTenant(f.tenantA, () =>
          runtime.query(`SELECT id FROM ${table} WHERE id=$1`, [foreignId]),
        ),
      ).toEqual([]);
    }
    const blockedInserts = [
      {
        sql: "INSERT INTO interviews(tenant_id,application_id,round,mode,starts_at,ends_at,created_by) VALUES($1,$2,'RLS attempt',$3,$4,$5,$6)",
        params: [
          f.tenantB,
          other.applicationId,
          InterviewMode.PHONE,
          time.startsAt,
          time.endsAt,
          f.adminB.id,
        ],
      },
      {
        sql: 'INSERT INTO interview_panelists(tenant_id,interview_id,user_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',
        params: [
          f.tenantB,
          other.interviewId,
          f.employeeA.id,
          time.startsAt,
          time.endsAt,
        ],
      },
      {
        sql: 'INSERT INTO interview_scorecards(tenant_id,interview_id,panelist_user_id,scores,recommendation) VALUES($1,$2,$3,$4,$5)',
        params: [
          f.tenantB,
          other.interviewId,
          otherUser.id,
          '[]',
          ScorecardRecommendation.HOLD,
        ],
      },
    ];
    for (const statement of blockedInserts)
      await expect(
        runWithTenant(f.tenantA, () =>
          runtime.query(statement.sql, statement.params),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.pool.query(
        "INSERT INTO interviews(tenant_id,application_id,round,mode,starts_at,ends_at,created_by) VALUES($1,$2,'Foreign reference',$3,$4,$5,$6)",
        [
          f.tenantA,
          other.applicationId,
          InterviewMode.PHONE,
          time.startsAt,
          time.endsAt,
          f.adminA.id,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      f.pool.query(
        'INSERT INTO interview_panelists(tenant_id,interview_id,user_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',
        [
          f.tenantA,
          own.interview.id,
          otherUser.id,
          own.body.startsAt,
          own.body.endsAt,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      f.pool.query(
        'INSERT INTO interview_scorecards(tenant_id,interview_id,panelist_user_id,scores,recommendation) VALUES($1,$2,$3,$4,$5)',
        [
          f.tenantA,
          other.interviewId,
          f.adminA.id,
          '[]',
          ScorecardRecommendation.HOLD,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    for (const sql of [
      'UPDATE interview_scorecards SET notes=$1 WHERE id=$2',
      'DELETE FROM interview_scorecards WHERE id=$1',
    ]) {
      await expect(
        runWithTenant(f.tenantA, () =>
          runtime.query(
            sql,
            sql.startsWith('UPDATE')
              ? ['Tampered evidence', ownCard.body.id]
              : [ownCard.body.id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    expect(
      (
        await f.pool.query(
          'SELECT notes FROM interview_scorecards WHERE id=$1',
          [ownCard.body.id],
        )
      ).rows[0].notes,
    ).toBe('');
  });
});
