import request from 'supertest';
import { encryptSecret } from '../../src/modules/super-admin/secrets';
import { InterviewMode, Role } from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';

describe('interviews in the connected calendar', () => {
  const f = useApiFixture();
  let calendar: { url: string; method: string; body: any }[];
  /** How the calendar answers event requests. */
  let reply: (url: string, method: string) => Response;
  let connectionId: string;
  let hour = 0;

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
    reply = (url, method) =>
      method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({
            id: 'event-1',
            organizer: { email: 'recruiting@example.test' },
            ...(url.includes('/events?') || method === 'PATCH'
              ? { hangoutLink: 'https://meet.google.com/abc-defg-hij' }
              : {}),
          });
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      calendar.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return reply(String(url), method);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  /** A future hour no other test uses. */
  function slot() {
    const start = Date.parse('2031-03-03T09:00:00Z') + hour++ * 3600000 * 3;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 45 * 60000).toISOString(),
    };
  }
  const schedule = (body: object) =>
    f.authorized('post', '/interviews').send(body);
  const chooseCalendar = (provider: string) =>
    request(f.app!.getHttpServer())
      .put(`${api}/interviews/calendar`)
      .auth(f.tokenA, { type: 'bearer' })
      .send({ provider });

  it('says which calendar invitations go out from', async () => {
    const status = await f
      .authorized('get', '/interviews/calendar')
      .expect(200);
    expect(status.body).toEqual({
      provider: 'google_calendar',
      connected: ['google_calendar'],
    });
  });

  it('invites the panel and the candidate, with a Meet link, and keeps the event in step', async () => {
    const { applicationId, candidateId } = await f.scenario();
    const interviewer = await f.user(f.tenantA, Role.INTERVIEWER);
    const time = slot();
    const created = await schedule({
      applicationId,
      round: 'Technical round',
      mode: InterviewMode.VIDEO,
      ...time,
      panelistIds: [f.adminA.id, interviewer.id],
      sendInvitations: true,
    }).expect(201);
    expect(created.body).toMatchObject({
      calendar: { status: 'added', provider: 'google_calendar' },
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      on_calendar: true,
      calendar_provider: 'google_calendar',
      candidate_name: 'Scenario Candidate',
      job_title: 'Backend Developer',
      scorecard_count: 0,
      my_scorecard: false,
    });
    expect(created.body.panel).toHaveLength(2);
    const [added] = calendar;
    expect(added.method).toBe('POST');
    expect(added.url).toContain('sendUpdates=all');
    expect(added.body).toMatchObject({
      summary: 'Technical round: Scenario Candidate · Backend Developer',
      start: { dateTime: new Date(time.startsAt).toISOString() },
      conferenceData: {
        createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    });
    expect(
      added.body.attendees.map((a: { email: string }) => a.email).sort(),
    ).toEqual(
      [f.adminA.email, interviewer.email, `${candidateId}@example.test`].sort(),
    );
    expect(added.body.description).toContain('Interview panel: ');

    // Rescheduled: the same event moves, and everyone is told.
    calendar = [];
    const later = slot();
    const moved = await f
      .authorized('patch', `/interviews/${created.body.id}`)
      .send({ ...later, round: 'Final round' })
      .expect(200);
    expect(moved.body).toMatchObject({
      round: 'Final round',
      calendar: { status: 'updated' },
      meeting_url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(calendar).toHaveLength(1);
    expect(calendar[0].method).toBe('PATCH');
    expect(calendar[0].url).toContain('/events/event-1?');
    expect(calendar[0].body.start).toEqual({
      dateTime: new Date(later.startsAt).toISOString(),
    });
    // It has a link already: no second meeting.
    expect(calendar[0].body.conferenceData).toBeUndefined();

    // Cancelled: the event goes.
    calendar = [];
    await f
      .authorized('post', `/interviews/${created.body.id}/cancel`)
      .send({ reason: 'Candidate withdrew' })
      .expect(200);
    expect(calendar.map((c) => c.method)).toEqual(['DELETE']);
    expect(calendar[0].url).toContain('/events/event-1?sendUpdates=all');
  });

  it('adds an interview scheduled without invitations later, with its own link', async () => {
    const { applicationId } = await f.scenario();
    const created = await schedule({
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.VIDEO,
      ...slot(),
      meetingUrl: 'https://zoom.example.test/j/1',
      panelistIds: [f.adminA.id],
    }).expect(201);
    expect(created.body).toMatchObject({
      calendar: { status: 'not_sent' },
      on_calendar: false,
    });
    expect(calendar).toEqual([]);
    const added = await f
      .authorized('post', `/interviews/${created.body.id}/calendar`)
      .expect(200);
    expect(added.body).toMatchObject({
      calendar: { status: 'added' },
      on_calendar: true,
      meeting_url: 'https://zoom.example.test/j/1',
    });
    expect(calendar[0].body.location).toBe('https://zoom.example.test/j/1');
    expect(calendar[0].body.conferenceData).toBeUndefined();
  });

  it('keeps the interview when the calendar refuses, and says why', async () => {
    const { applicationId } = await f.scenario();
    reply = () => new Response(null, { status: 401 });
    const created = await schedule({
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.ONSITE,
      location: 'Noida office',
      ...slot(),
      panelistIds: [f.adminA.id],
      sendInvitations: true,
    }).expect(201);
    expect(created.body).toMatchObject({
      status: 'SCHEDULED',
      on_calendar: false,
      calendar: { status: 'failed', problem: 'auth' },
    });
  });

  it('needs a meeting link, or a connected calendar to create one', async () => {
    const { applicationId } = await f.scenario();
    const body = {
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.VIDEO,
      ...slot(),
      panelistIds: [f.adminA.id],
    };
    await schedule(body).expect(400);
    await f.pool.query(
      "UPDATE integration_configs SET status='unverified' WHERE id=$1",
      [connectionId],
    );
    try {
      const refused = await schedule({ ...body, sendInvitations: true }).expect(
        409,
      );
      expect(refused.body.message).toMatch(/Connect Google Calendar/);
      const status = await f
        .authorized('get', '/interviews/calendar')
        .expect(200);
      expect(status.body).toEqual({ provider: null, connected: [] });
    } finally {
      await f.pool.query(
        "UPDATE integration_configs SET status='enabled' WHERE id=$1",
        [connectionId],
      );
    }
    expect(calendar).toEqual([]);
  });

  it('lists interviews in a time range, upcoming or past, with the candidate and the panel', async () => {
    const { applicationId, jobId } = await f.scenario();
    const time = slot();
    const created = await schedule({
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.PHONE,
      ...time,
      panelistIds: [f.adminA.id],
    }).expect(201);
    const from = new Date(Date.parse(time.startsAt) - 3600000).toISOString();
    const to = new Date(Date.parse(time.endsAt) + 3600000).toISOString();
    const listed = await f
      .authorized(
        'get',
        `/interviews?when=upcoming&jobId=${jobId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      )
      .expect(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.data[0]).toMatchObject({
      id: created.body.id,
      application_id: applicationId,
      job_id: jobId,
      application_stage: 'SHORTLISTED',
      candidate_name: 'Scenario Candidate',
      panel: [{ id: f.adminA.id, full_name: 'Test User', role: 'HR_ADMIN' }],
      created_by_name: 'Test User',
    });
    const past = await f
      .authorized('get', `/interviews?when=past&jobId=${jobId}`)
      .expect(200);
    expect(past.body.total).toBe(0);
  });

  /** Microsoft Calendar connected too, for the duration of `work`. */
  async function withMicrosoft(work: () => Promise<void>) {
    const { rows } = await f.pool.query(
      `INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES('microsoft_calendar',$1,true,$2)
       ON CONFLICT(provider) DO UPDATE SET enabled=true,tenant_id=EXCLUDED.tenant_id,updated_by=EXCLUDED.updated_by
       RETURNING revision`,
      [f.tenantA, f.adminA.id],
    );
    const connection = await f.pool.query<{ id: string }>(
      `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,provider_revision,updated_by)
       VALUES($1,$1,'organization','microsoft_calendar','production','bearer','enabled',$2,'****oken',$3,$4)
       ON CONFLICT (tenant_id,provider,environment,coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET status='enabled',encrypted_credentials=EXCLUDED.encrypted_credentials,provider_revision=EXCLUDED.provider_revision
       RETURNING id`,
      [
        f.tenantA,
        encryptSecret(
          JSON.stringify({ accessToken: 'graph-token' }),
          `organization:${f.tenantA}:microsoft_calendar:production`,
        ),
        rows[0].revision,
        f.adminA.id,
      ],
    );
    try {
      await work();
    } finally {
      await f.pool.query(
        "UPDATE integration_configs SET status='unverified' WHERE id=$1",
        [connection.rows[0].id],
      );
      await f.pool.query(
        'UPDATE organization_ai_settings SET interview_calendar=NULL WHERE tenant_id=$1',
        [f.tenantA],
      );
    }
  }
  /** Microsoft Graph's replies, then Google's. */
  const graph = (teams = true) => {
    const google = reply;
    reply = (url, method) =>
      url.startsWith('https://graph.microsoft.com/')
        ? method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({
              id: 'ms-event-1',
              organizer: { emailAddress: { address: 'hr@contoso.test' } },
              onlineMeeting: teams
                ? { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }
                : null,
            })
        : google(url, method);
  };

  it('with both calendars connected, uses the one an HR Admin chose, and moves an interview', async () => {
    await withMicrosoft(async () => {
      graph();
      const before = await f
        .authorized('get', '/interviews/calendar')
        .expect(200);
      expect(before.body).toEqual({
        provider: 'google_calendar',
        connected: ['google_calendar', 'microsoft_calendar'],
      });
      const chosen = await chooseCalendar('microsoft_calendar').expect(200);
      expect(chosen.body.provider).toBe('microsoft_calendar');

      const { applicationId, candidateId } = await f.scenario();
      const created = await schedule({
        applicationId,
        round: 'Round 1',
        mode: InterviewMode.VIDEO,
        ...slot(),
        panelistIds: [f.adminA.id],
        sendInvitations: true,
      }).expect(201);
      expect(created.body).toMatchObject({
        calendar_provider: 'microsoft_calendar',
        meeting_url: 'https://teams.microsoft.com/l/meetup-join/abc',
        calendar: {
          status: 'added',
          provider: 'microsoft_calendar',
          organizer: 'hr@contoso.test',
          candidate: `${candidateId}@example.test`,
          panel: 1,
          warnings: [],
        },
      });
      const [sent] = calendar;
      expect(sent.url).toBe('https://graph.microsoft.com/v1.0/me/events');
      expect(sent.body).toMatchObject({
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
      });
      expect(
        sent.body.attendees.map(
          (a: { emailAddress: { address: string } }) => a.emailAddress.address,
        ),
      ).toContain(`${candidateId}@example.test`);

      // Moved to Google: a Meet link replaces the Teams one, and the old
      // event is cancelled.
      calendar = [];
      const moved = await f
        .authorized('post', `/interviews/${created.body.id}/calendar`)
        .send({ calendarProvider: 'google_calendar' })
        .expect(200);
      expect(moved.body).toMatchObject({
        calendar_provider: 'google_calendar',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
        calendar: { status: 'moved', provider: 'google_calendar' },
      });
      expect(calendar.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual(
        [
          'POST https://www.googleapis.com/calendar/v3/calendars/primary/events',
          'DELETE https://graph.microsoft.com/v1.0/me/events/ms-event-1',
        ],
      );
      expect(calendar[0].body.conferenceData).toBeDefined();
    });
  });

  it('still invites from a Microsoft account without Teams, and says there’s no link', async () => {
    await withMicrosoft(async () => {
      graph(false);
      const google = reply;
      let tries = 0;
      reply = (url, method) =>
        url.startsWith('https://graph.microsoft.com/') && tries++ === 0
          ? new Response(null, { status: 400 })
          : google(url, method);
      const { applicationId } = await f.scenario();
      const created = await schedule({
        applicationId,
        round: 'Round 1',
        mode: InterviewMode.VIDEO,
        ...slot(),
        panelistIds: [f.adminA.id],
        sendInvitations: true,
        calendarProvider: 'microsoft_calendar',
      }).expect(201);
      expect(created.body).toMatchObject({
        meeting_url: null,
        calendar: {
          status: 'added',
          provider: 'microsoft_calendar',
          warnings: ['no_meeting_link'],
        },
      });
      expect(calendar.map((c) => c.body?.isOnlineMeeting)).toEqual([
        true,
        undefined,
      ]);
    });
  });

  it('warns when the candidate’s address is the calendar’s own account', async () => {
    const { applicationId, candidateId } = await f.scenario();
    const google = reply;
    reply = (url, method) =>
      method === 'POST'
        ? Response.json({
            id: 'event-2',
            organizer: { email: `${candidateId}@EXAMPLE.test` },
          })
        : google(url, method);
    const created = await schedule({
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.PHONE,
      ...slot(),
      panelistIds: [f.adminA.id],
      sendInvitations: true,
    }).expect(201);
    expect(created.body.calendar).toMatchObject({
      status: 'added',
      warnings: ['candidate_is_organizer'],
    });
  });

  it('refuses a calendar that isn’t connected', async () => {
    const { applicationId } = await f.scenario();
    const refused = await schedule({
      applicationId,
      round: 'Round 1',
      mode: InterviewMode.PHONE,
      ...slot(),
      panelistIds: [f.adminA.id],
      sendInvitations: true,
      calendarProvider: 'microsoft_calendar',
    }).expect(409);
    expect(refused.body.message).toMatch(/Microsoft Calendar isn’t connected/);
    await chooseCalendar('microsoft_calendar').expect(409);
    expect(calendar).toEqual([]);
  });
});
