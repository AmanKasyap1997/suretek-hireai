import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { encryptSecret } from '../../src/modules/super-admin/secrets';
import {
  CallingClock,
  HiringAutomationService,
  InterviewBookingService,
  WorkRecoveryService,
} from '../../src/modules/talent-acquisition';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { ApplicationStage, ConsentScope } from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';

// Monday 5 January 2026, 10:00 (the fixture's calling time zone is UTC).
const NOW = new Date('2026-01-05T10:00:00Z');

describe('automatic hiring steps', () => {
  const f = useApiFixture();
  let calendar: { url: string; method: string; body: any }[];
  /** What the calendar says is busy. */
  let busy: { start: string; end: string }[];
  let connectionId: string;

  beforeAll(async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY ??= 'ab'.repeat(32);
    const { rows } = await f.pool.query(
      `INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES('google_calendar',$1,true,$2)
       ON CONFLICT(provider) DO UPDATE SET enabled=true,tenant_id=EXCLUDED.tenant_id,updated_by=EXCLUDED.updated_by
       RETURNING revision`,
      [f.tenantA, f.adminA.id],
    );
    const connection = await f.pool.query<{ id: string }>(
      `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,provider_revision,updated_by)
       VALUES($1,$1,'organization','google_calendar','production','bearer','enabled',$2,'****oken',$3,$4) RETURNING id`,
      [
        f.tenantA,
        encryptSecret(
          JSON.stringify({ accessToken: 'calendar-token' }),
          `organization:${f.tenantA}:google_calendar:production`,
        ),
        rows[0].revision,
        f.adminA.id,
      ],
    );
    connectionId = connection.rows[0].id;
  });

  beforeEach(() => {
    calendar = [];
    busy = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calendar.push({ url: String(url), method: init?.method ?? 'GET', body });
      if (String(url).endsWith('/freeBusy'))
        return Response.json({
          calendars: Object.fromEntries(
            body.items.map((item: { id: string }) => [item.id, { busy }]),
          ),
        });
      if (String(url).includes('/events?'))
        return Response.json({
          id: 'event-1',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    jest.spyOn(f.app!.get(CallingClock), 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  const automation = () => f.app!.get(HiringAutomationService);
  const booking = () => f.app!.get(InterviewBookingService);
  const inTenant = <T>(work: () => Promise<T>) =>
    runWithTenant(f.tenantA, work);
  const row = async (sql: string, params: unknown[]) =>
    (await f.pool.query(sql, params)).rows[0];
  const setup = () => ({
    round: 'Final round',
    minutes: 45,
    mode: 'VIDEO',
    panelistIds: [f.adminA.id],
    days: [1, 2, 3, 4, 5],
    startMinute: 10 * 60,
    endMinute: 17 * 60,
  });

  /** An application at a stage, whose candidate may be called. */
  async function applicant(stage: ApplicationStage, booked = false) {
    const ids = await f.scenario();
    await f.pool.query(
      'UPDATE applications SET stage=$3 WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, ids.applicationId, stage],
    );
    await f
      .authorized('post', `/candidates/${ids.candidateId}/consents`)
      .send({ scope: ConsentScope.CALL, granted: true, source: 'Opt-in form' })
      .expect(201);
    if (booked)
      await request(f.app!.getHttpServer())
        .put(`${api}/jobs/${ids.jobId}/interview-setup`)
        .auth(f.tokenA, { type: 'bearer' })
        .send({ interviewSetup: setup() })
        .expect(200);
    return ids;
  }
  const automate = (body: object) =>
    request(f.app!.getHttpServer())
      .put(`${api}/organization/ai-settings/automation`)
      .auth(f.tokenA, { type: 'bearer' })
      .send(body);
  const calls = (applicationId: string) =>
    f.pool
      .query(
        'SELECT purpose,status,requested_by FROM call_requests WHERE tenant_id=$1 AND application_id=$2 ORDER BY created_at',
        [f.tenantA, applicationId],
      )
      .then((r) => r.rows);
  const stageOf = async (applicationId: string) =>
    (
      await row('SELECT stage FROM applications WHERE tenant_id=$1 AND id=$2', [
        f.tenantA,
        applicationId,
      ])
    ).stage;

  it('lets an HR Admin turn the steps on, with their scores', async () => {
    const saved = await automate({
      shortlistScore: 70,
      callShortlisted: true,
      interviewScore: 70,
    }).expect(200);
    expect(saved.body.automation).toEqual({
      shortlist_score: 70,
      call_shortlisted: true,
      interview_score: 70,
    });
    await automate({
      shortlistScore: 0,
      callShortlisted: true,
      interviewScore: null,
    }).expect(400);
  });

  it('shortlists at the resume score and calls, but never with a missing must-have', async () => {
    await automate({
      shortlistScore: 70,
      callShortlisted: true,
      interviewScore: 70,
    }).expect(200);
    const strong = await applicant(ApplicationStage.APPLIED);
    const weak = await applicant(ApplicationStage.APPLIED);
    const missing = await applicant(ApplicationStage.APPLIED);
    const screened = (id: string, score: number, missingMustHave = false) =>
      inTenant(() =>
        automation().screened(f.tenantA, id, {
          id: randomUUID(),
          score,
          missingMustHave,
        }),
      );
    await screened(strong.applicationId, 82);
    await screened(weak.applicationId, 65);
    await screened(missing.applicationId, 90, true);

    expect(await stageOf(strong.applicationId)).toBe('SHORTLISTED');
    expect(
      await row(
        "SELECT note,actor_id FROM application_stage_events WHERE tenant_id=$1 AND application_id=$2 AND to_stage='SHORTLISTED'",
        [f.tenantA, strong.applicationId],
      ),
    ).toEqual({
      note: 'Automatic: resume score 82 (shortlisted at 70 or more)',
      actor_id: null,
    });
    // The AI screening call, placed by HireAI itself.
    expect(await calls(strong.applicationId)).toEqual([
      { purpose: 'SCREENING', status: 'PLANNED', requested_by: null },
    ]);
    for (const other of [weak, missing]) {
      expect(await stageOf(other.applicationId)).toBe('APPLIED');
      expect(await calls(other.applicationId)).toEqual([]);
    }
  });

  it('moves a strong call to interviews and plans the booking call', async () => {
    await automate({
      shortlistScore: null,
      callShortlisted: false,
      interviewScore: 70,
    }).expect(200);
    const screeningCall = async (applicationId: string) =>
      (
        await row(
          `INSERT INTO call_requests(tenant_id,application_id,requested_by,language,status,outcome,idempotency_key,completed_at)
           VALUES($1,$2,$3,'EN','COMPLETED','COMPLETED',$4,now()) RETURNING id`,
          [f.tenantA, applicationId, f.adminA.id, randomUUID()],
        )
      ).id as string;
    const assessed = (requestId: string, score: number, dealBreaker = false) =>
      inTenant(() =>
        automation().callAssessed(f.tenantA, requestId, {
          score,
          deal_breaker: dealBreaker,
        }),
      );

    const strong = await applicant(ApplicationStage.SHORTLISTED, true);
    await assessed(await screeningCall(strong.applicationId), 75);
    expect(await stageOf(strong.applicationId)).toBe('INTERVIEW');
    expect((await calls(strong.applicationId)).at(-1)).toEqual({
      purpose: 'SCHEDULING',
      status: 'PLANNED',
      requested_by: null,
    });

    // A wrong yes/no deal-breaker answer: a recruiter decides.
    const breaker = await applicant(ApplicationStage.SHORTLISTED, true);
    await assessed(await screeningCall(breaker.applicationId), 95, true);
    expect(await stageOf(breaker.applicationId)).toBe('SHORTLISTED');

    // No interview booking on the job: moved on, and the reason is kept.
    const unbooked = await applicant(ApplicationStage.SHORTLISTED);
    await assessed(await screeningCall(unbooked.applicationId), 80);
    expect(await stageOf(unbooked.applicationId)).toBe('INTERVIEW');
    expect(
      (await calls(unbooked.applicationId)).filter(
        (c) => c.purpose === 'SCHEDULING',
      ),
    ).toEqual([]);
    expect(
      await row(
        "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND action='call.auto_not_planned' AND entity_id=$2",
        [f.tenantA, unbooked.applicationId],
      ),
    ).toEqual({
      metadata: {
        purpose: 'SCHEDULING',
        reason: 'The job has no interview booking set up.',
      },
    });
  });

  /** A booking call's attempt offering these times. */
  async function attemptOffering(applicationId: string, slots: unknown) {
    const callRequest = await row(
      `INSERT INTO call_requests(tenant_id,application_id,language,status,idempotency_key,purpose)
       VALUES($1,$2,'EN','IN_PROGRESS',$3,'SCHEDULING') RETURNING id`,
      [f.tenantA, applicationId, randomUUID()],
    );
    return (
      await row(
        `INSERT INTO call_attempts(tenant_id,call_request_id,number,status,connection_id,slots)
         VALUES($1,$2,1,'IN_PROGRESS',$3,$4) RETURNING id`,
        [f.tenantA, callRequest.id, connectionId, JSON.stringify(slots)],
      )
    ).id as string;
  }

  it('offers times the panel is free and books the one picked, inviting everyone', async () => {
    const { applicationId, candidateId } = await applicant(
      ApplicationStage.INTERVIEW,
      true,
    );
    // Tuesday morning is taken in the calendar.
    busy = [{ start: '2026-01-06T09:00:00Z', end: '2026-01-06T12:00:00Z' }];
    const slots = await inTenant(() =>
      booking().offer(f.tenantA, applicationId),
    );
    expect(slots.map((s) => [s.startsAt, s.label])).toEqual([
      ['2026-01-06T12:00:00.000Z', 'Tuesday 6 January at 12:00 PM'],
      ['2026-01-07T10:00:00.000Z', 'Wednesday 7 January at 10:00 AM'],
      ['2026-01-08T10:00:00.000Z', 'Thursday 8 January at 10:00 AM'],
    ]);
    const freeBusy = calendar.find((c) => c.url.endsWith('/freeBusy'))!;
    expect(freeBusy.body.items).toEqual([
      { id: 'primary' },
      { id: expect.stringContaining('@example.test') },
    ]);

    const attemptId = await attemptOffering(applicationId, slots);
    busy = [];
    expect(
      await inTenant(() => booking().book(f.tenantA, attemptId, 's2')),
    ).toMatchObject({ booked: true, when: 'Wednesday 7 January at 10:00 AM' });
    const interview = await row(
      `SELECT i.id,i.round,i.mode,i.starts_at,i.ends_at,i.meeting_url,i.created_by,i.calendar_provider,i.calendar_event_id,
         ARRAY(SELECT user_id FROM interview_panelists p WHERE p.tenant_id=i.tenant_id AND p.interview_id=i.id) AS panel
       FROM interviews i WHERE i.tenant_id=$1 AND i.application_id=$2`,
      [f.tenantA, applicationId],
    );
    expect(interview).toMatchObject({
      round: 'Final round',
      mode: 'VIDEO',
      starts_at: new Date('2026-01-07T10:00:00Z'),
      ends_at: new Date('2026-01-07T10:45:00Z'),
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      created_by: null,
      calendar_provider: 'google_calendar',
      calendar_event_id: 'event-1',
      panel: [f.adminA.id],
    });
    const event = calendar.find((c) => c.url.includes('/events?'))!;
    expect(event.url).toContain('sendUpdates=all');
    expect(event.body.attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: `${candidateId}@example.test` }),
      ]),
    );
    expect(
      event.body.conferenceData.createRequest.conferenceSolutionKey,
    ).toEqual({ type: 'hangoutsMeet' });
    expect(
      await row(
        'SELECT booked_interview_id FROM call_attempts WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, attemptId],
      ),
    ).toEqual({ booked_interview_id: interview.id });

    // The recruiter sees what was booked on the call.
    const view = await f
      .authorized('get', `/applications/${applicationId}/calls`)
      .expect(200);
    expect(view.body.calls[0]).toMatchObject({
      purpose: 'SCHEDULING',
      automatic: true,
    });
    expect(view.body.calls[0].attempt_history[0]).toMatchObject({
      offered_slots: slots.map((s) => s.label),
      booked_interview: {
        mode: 'VIDEO',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
      },
    });

    // Another candidate can't have the panel at the same time.
    const other = await applicant(ApplicationStage.INTERVIEW, true);
    const otherAttempt = await attemptOffering(other.applicationId, slots);
    expect(
      await inTenant(() => booking().book(f.tenantA, otherAttempt, 's2')),
    ).toEqual({ booked: false, reason: 'taken' });
    expect(calendar.filter((c) => c.url.includes('/events?'))).toHaveLength(1);

    // Cancelling the interview takes the calendar invitation back.
    await f
      .authorized('post', `/interviews/${interview.id}/cancel`)
      .send({ reason: 'Candidate withdrew' })
      .expect(200);
    expect(calendar.find((c) => c.method === 'DELETE')?.url).toContain(
      '/events/event-1',
    );
  });

  it('picks up screenings and call assessments a restart left behind', async () => {
    const { applicationId, candidateId } = await applicant(
      ApplicationStage.APPLIED,
    );
    const document = await row(
      "INSERT INTO candidate_documents(tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256) VALUES($1,$2,$3,'resume.pdf','application/pdf',1,$4) RETURNING id",
      [f.tenantA, candidateId, `${f.tenantA}/${randomUUID()}`, '0'.repeat(64)],
    );
    // Queued before the restart; nothing in memory knows about it now.
    const screening = await row(
      `INSERT INTO application_screenings(tenant_id,application_id,document_id,trigger,criteria)
       VALUES($1,$2,$3,'AUTOMATIC','[]') RETURNING id`,
      [f.tenantA, applicationId, document.id],
    );
    // A call that ended with answers just before the restart: never assessed.
    const callRequest = await row(
      `INSERT INTO call_requests(tenant_id,application_id,language,status,outcome,idempotency_key,completed_at)
       VALUES($1,$2,'EN','COMPLETED','COMPLETED',$3,now()) RETURNING id`,
      [f.tenantA, applicationId, randomUUID()],
    );
    const attempt = await row(
      `INSERT INTO call_attempts(tenant_id,call_request_id,number,status,connection_id,outcome,answers,updated_at)
       VALUES($1,$2,1,'COMPLETED',$3,'COMPLETED',$4,now()-interval '5 minutes') RETURNING id`,
      [
        f.tenantA,
        callRequest.id,
        connectionId,
        JSON.stringify([
          {
            question_id: 'q-relocate',
            question: 'Are you open to working from our Noida office?',
            answered: true,
            answer: 'Yes.',
            value: 'yes',
            expected_answer: 'yes',
            matches_expected: true,
          },
        ]),
      ],
    );
    await f.app!.get(WorkRecoveryService).sweep();
    // Both run again. The screening gets as far as reading the resume (the
    // test's file isn't in storage); the assessment scores the answer.
    const settled = async () => {
      for (let i = 0; i < 50; i++) {
        const [s, a] = await Promise.all([
          row(
            'SELECT status,failure FROM application_screenings WHERE tenant_id=$1 AND id=$2',
            [f.tenantA, screening.id],
          ),
          row(
            'SELECT assessment_status FROM call_attempts WHERE tenant_id=$1 AND id=$2',
            [f.tenantA, attempt.id],
          ),
        ]);
        if (
          s.status !== 'QUEUED' &&
          s.status !== 'RUNNING' &&
          a.assessment_status !== null &&
          a.assessment_status !== 'PENDING'
        )
          return { screening: s, assessment: a.assessment_status };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Not picked up');
    };
    expect(await settled()).toEqual({
      screening: { status: 'FAILED', failure: 'resume_unavailable' },
      assessment: 'COMPLETED',
    });
  });

  it('offers no times without a calendar setup on the job', async () => {
    const { applicationId } = await applicant(ApplicationStage.INTERVIEW);
    await expect(
      inTenant(() => booking().offer(f.tenantA, applicationId)),
    ).rejects.toMatchObject({ failure: 'no_interview_setup' });
  });
});
