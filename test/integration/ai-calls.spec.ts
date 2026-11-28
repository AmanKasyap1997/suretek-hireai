import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import WebSocket from 'ws';
import { encryptSecret } from '../../src/modules/super-admin/secrets';
import {
  CallAssessmentService,
  CallDispatchService,
  CallRecordsService,
  CallingClock,
  TestCallsService,
  phoneCallSetup,
} from '../../src/modules/talent-acquisition';
import { DbService } from '../../src/platform/database/db.service';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { ApplicationStage, ConsentScope } from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';

const PUBLIC = 'https://calls.example.test';
const AUTH_TOKEN = 'plivo-auth-token-for-integration';
const START = new Date('2026-01-01T10:00:00Z');

describe('AI calls', () => {
  const f = useApiFixture();
  let plivo: {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
  }[];

  beforeAll(async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY ??= 'ab'.repeat(32);
    process.env.PUBLIC_API_BASE_URL = PUBLIC;
    const revision: Record<string, number> = {};
    for (const provider of ['plivo', 'google_ai']) {
      const { rows } = await f.pool.query(
        `INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES($1,$2,true,$3)
         ON CONFLICT(provider) DO UPDATE SET enabled=true,tenant_id=EXCLUDED.tenant_id,updated_by=EXCLUDED.updated_by
         RETURNING revision`,
        [provider, f.tenantA, f.adminA.id],
      );
      revision[provider] = rows[0].revision;
    }
    const connect = (provider: string, method: string, secret: object) =>
      f.pool.query(
        `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,provider_revision,updated_by)
         VALUES($1,$1,'organization',$2,'sandbox',$3,'enabled',$4,'****test',$5,$6)`,
        [
          f.tenantA,
          provider,
          method,
          encryptSecret(
            JSON.stringify(secret),
            `organization:${f.tenantA}:${provider}:sandbox`,
          ),
          revision[provider],
          f.adminA.id,
        ],
      );
    await connect('plivo', 'account_token', {
      authId: 'MAINTEGRATIONTEST000',
      authToken: AUTH_TOKEN,
      phoneNumber: '+918045671234',
    });
    await connect('google_ai', 'api_key', { apiKey: 'fake-google-key' });
  });
  afterAll(() => {
    delete process.env.PUBLIC_API_BASE_URL;
  });
  beforeEach(async () => {
    // Calls left waiting by an earlier test would be dialed alongside.
    await f.pool.query(
      "UPDATE call_attempts SET status='CANCELLED' WHERE tenant_id=$1 AND status IN ('DIALING','IN_PROGRESS')",
      [f.tenantA],
    );
    await f.pool.query(
      "UPDATE call_requests SET status='CANCELLED' WHERE tenant_id=$1 AND status IN ('PLANNED','IN_PROGRESS')",
      [f.tenantA],
    );
    plivo = [];
    // Assessments are run explicitly where a test needs one.
    jest
      .spyOn(f.app!.get(CallAssessmentService), 'queue')
      .mockImplementation(() => undefined);
    jest.spyOn(f.app!.get(CallingClock), 'now').mockReturnValue(START);
    let n = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      plivo.push({ url: String(url), method: init?.method ?? 'GET', body });
      return String(url).endsWith('/Call/') && init?.method === 'POST'
        ? new Response(JSON.stringify({ request_uuid: `req-${++n}` }), {
            status: 201,
          })
        : new Response(null, { status: 204 });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const clock = (at: Date | string) =>
    jest.spyOn(f.app!.get(CallingClock), 'now').mockReturnValue(new Date(at));

  /** A shortlisted application whose candidate agreed to calls (and more). */
  async function callable(scopes = [ConsentScope.CALL]) {
    const ids = await f.scenario();
    await f.pool.query(
      'UPDATE candidates SET phone=$3 WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, ids.candidateId, '+919876543210'],
    );
    for (const scope of scopes)
      await f
        .authorized('post', `/candidates/${ids.candidateId}/consents`)
        .send({ scope, granted: true, source: `Opt-in form ${scope}` })
        .expect(201);
    return ids;
  }

  const ask = (applicationId: string, extra = {}) =>
    f
      .authorized('post', '/call-requests')
      .send({
        applicationId,
        language: 'EN',
        idempotencyKey: randomUUID(),
        ...extra,
      })
      .expect(201);

  const dispatch = () =>
    runWithTenant(f.tenantA, () =>
      f.app!.get(CallDispatchService).organization(f.tenantA),
    );

  const row = async (sql: string, params: unknown[]) =>
    (await f.pool.query(sql, params)).rows[0];

  const attemptOf = (requestId: string) =>
    row(
      'SELECT * FROM call_attempts WHERE tenant_id=$1 AND call_request_id=$2 ORDER BY number DESC LIMIT 1',
      [f.tenantA, requestId],
    );

  /** The Plivo request that dialed an attempt. */
  const dialFor = (attemptId: string) =>
    plivo.find((c) => String(c.body?.answer_url ?? '').includes(attemptId))!;

  /** Posts to a Plivo callback with Plivo's signature. */
  function webhook(url: string, params: Record<string, string>, sign = true) {
    const path = url.slice(PUBLIC.length);
    const nonce = `nonce-${randomUUID()}`;
    const signed = `${PUBLIC}${path}.${Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('')}.${nonce}`;
    return request(f.app!.getHttpServer())
      .post(path)
      .type('form')
      .send(params)
      .set('X-Plivo-Signature-V3-Nonce', nonce)
      .set(
        'X-Plivo-Signature-V3',
        createHmac('sha256', sign ? AUTH_TOKEN : 'wrong-token')
          .update(signed)
          .digest('base64'),
      );
  }

  it('dials during calling hours, streams the answered call, and retries when the stream fails', async () => {
    const { applicationId } = await callable();
    const planned = await ask(applicationId);
    expect(planned.body).toMatchObject({
      status: 'PLANNED',
      next_attempt_at: START.toISOString(),
    });
    const directory = await f.pool.query(
      'SELECT * FROM call_dispatch_organizations(1000) AS id',
    );
    expect(directory.rows.map((r) => r.id)).toContain(f.tenantA);

    await dispatch();
    const attempt = await attemptOf(planned.body.id);
    const dial = dialFor(attempt.id);
    expect(dial.url).toBe(
      'https://api.plivo.com/v1/Account/MAINTEGRATIONTEST000/Call/',
    );
    expect(dial.body).toMatchObject({
      from: '+918045671234',
      to: '+919876543210',
      ring_timeout: 30,
    });
    expect(attempt).toMatchObject({
      status: 'DIALING',
      number: 1,
      provider_request_id: expect.stringMatching(/^req-\d+$/),
    });
    expect(
      await row(
        'SELECT status,attempts FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, planned.body.id],
      ),
    ).toEqual({ status: 'IN_PROGRESS', attempts: 1 });

    const answerUrl = String(dial.body!.answer_url);
    const params = {
      CallUUID: 'call-uuid-1',
      CallStatus: 'in-progress',
      To: '+919876543210',
    };
    await webhook(
      answerUrl.replace(/token=[^&]+/, 'token=forged-token-value'),
      params,
    ).expect(403);
    await webhook(answerUrl, params, false).expect(403);
    const answered = await webhook(answerUrl, params).expect(200);
    expect(answered.headers['content-type']).toMatch(/application\/xml/);
    expect(answered.text).toContain('<Stream bidirectional="true"');
    expect(answered.text).toContain(
      `wss://calls.example.test/api/v1/public/calls/plivo/stream/${f.tenantA}/${attempt.id}/`,
    );
    expect(await attemptOf(planned.body.id)).toMatchObject({
      status: 'IN_PROGRESS',
      provider_call_id: 'call-uuid-1',
    });

    // The audio stream never connected; Plivo reports the hang-up.
    await webhook(String(dial.body!.hangup_url), {
      CallUUID: 'call-uuid-1',
      HangupCauseName: 'Normal Hangup',
    }).expect(204);
    expect(await attemptOf(planned.body.id)).toMatchObject({
      status: 'FAILED',
      failure: 'stream_failed',
    });
    const retry = await row(
      'SELECT status,attempts,failure,next_attempt_at FROM call_requests WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, planned.body.id],
    );
    expect(retry).toMatchObject({
      status: 'PLANNED',
      attempts: 1,
      failure: 'stream_failed',
    });
    expect(retry.next_attempt_at.toISOString()).toBe(
      '2026-01-01T12:00:00.000Z',
    );

    const panel = await f
      .authorized('get', `/applications/${applicationId}/calls`)
      .expect(200);
    expect(panel.body).toMatchObject({
      can_call: false,
      blocked: 'A call is already scheduled or in progress.',
      consents: { call: true, recording: false, transcription: false },
    });
    expect(panel.body.calls[0]).toMatchObject({
      status: 'PLANNED',
      question_count: 1,
      attempts: 1,
      failure_message: expect.stringContaining('audio link'),
    });
    expect(panel.body.calls[0].attempt_history[0]).toMatchObject({
      number: 1,
      status: 'FAILED',
    });
  });

  it('gives up after the last unanswered attempt', async () => {
    const { applicationId } = await callable();
    const planned = await ask(applicationId);
    for (const [i, at] of ['10:00', '12:00', '14:00'].entries()) {
      clock(`2026-01-01T${at}:00Z`);
      await dispatch();
      const attempt = await attemptOf(planned.body.id);
      expect(attempt).toMatchObject({ number: i + 1, status: 'DIALING' });
      const dial = dialFor(attempt.id);
      await webhook(String(dial.body!.hangup_url), {
        CallUUID: `call-${i}`,
        HangupCauseName: 'No Answer',
      }).expect(204);
      expect((await attemptOf(planned.body.id)).status).toBe('NO_ANSWER');
    }
    expect(
      await row(
        'SELECT status,outcome,failure,attempts FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, planned.body.id],
      ),
    ).toEqual({
      status: 'FAILED',
      outcome: 'UNREACHED',
      failure: 'unreached',
      attempts: 3,
    });
  });

  describe('when the candidate asks to be called back', () => {
    type End = Parameters<CallRecordsService['finishAttempt']>[2];
    const busy = (callbackAt: Date | null): End => ({
      status: 'COMPLETED',
      outcome: 'CALL_BACK',
      summary: 'Busy now.',
      callbackNote: 'at 2 pm',
      callbackAt,
    });
    /** A call request, and a way to dial it at a time and end the call. */
    async function calling() {
      const { applicationId } = await callable();
      const planned = await ask(applicationId);
      const request = () =>
        row(
          'SELECT status,outcome,attempts,next_attempt_at FROM call_requests WHERE tenant_id=$1 AND id=$2',
          [f.tenantA, planned.body.id],
        );
      const callAt = async (at: string, end: End) => {
        clock(at);
        await dispatch();
        const attempt = await attemptOf(planned.body.id);
        expect(attempt.status).toBe('DIALING');
        await f
          .app!.get(CallRecordsService)
          .finishAttempt(f.tenantA, attempt.id, end);
        return request();
      };
      return { applicationId, callAt };
    }

    it('calls back at the agreed time, without using up the attempts', async () => {
      const { applicationId, callAt } = await calling();
      // "Call me at 2 PM": at 2 PM.
      expect(
        await callAt(
          '2026-01-01T10:00:00Z',
          busy(new Date('2026-01-01T14:00:00Z')),
        ),
      ).toMatchObject({
        status: 'PLANNED',
        attempts: 1,
        next_attempt_at: new Date('2026-01-01T14:00:00Z'),
      });
      // "At 8 PM", after calling hours (09:00–18:00): when they next open.
      expect(
        await callAt(
          '2026-01-01T14:00:00Z',
          busy(new Date('2026-01-01T20:00:00Z')),
        ),
      ).toMatchObject({
        status: 'PLANNED',
        next_attempt_at: new Date('2026-01-02T09:00:00Z'),
      });
      // Then nobody answers: the call-backs didn't use up the 3 attempts.
      for (const at of ['2026-01-02T09:00:00Z', '2026-01-02T11:00:00Z'])
        expect(await callAt(at, { status: 'NO_ANSWER' })).toMatchObject({
          status: 'PLANNED',
        });
      expect(
        await callAt('2026-01-02T13:00:00Z', { status: 'NO_ANSWER' }),
      ).toMatchObject({ status: 'FAILED', outcome: 'UNREACHED', attempts: 5 });
      const view = await f
        .authorized('get', `/applications/${applicationId}/calls`)
        .expect(200);
      expect(view.body.calls[0]).toMatchObject({
        attempts: 5,
        max_attempts: 5,
      });
    });

    it('waits the usual delay without a usable time, and counts a third call-back as an attempt', async () => {
      const { callAt } = await calling();
      // No time agreed ("call me later"): two hours.
      expect(await callAt('2026-01-01T10:00:00Z', busy(null))).toMatchObject({
        next_attempt_at: new Date('2026-01-01T12:00:00Z'),
      });
      // A time that's already past, such as a misheard one: two hours.
      expect(
        await callAt(
          '2026-01-01T12:00:00Z',
          busy(new Date('2026-01-01T09:00:00Z')),
        ),
      ).toMatchObject({ next_attempt_at: new Date('2026-01-01T14:00:00Z') });
      // A third call-back is an ordinary attempt: the usual delay.
      expect(
        await callAt(
          '2026-01-01T14:00:00Z',
          busy(new Date('2026-01-01T17:30:00Z')),
        ),
      ).toMatchObject({
        status: 'PLANNED',
        next_attempt_at: new Date('2026-01-01T16:00:00Z'),
      });
    });
  });

  it('doesn’t dial a booking call without interview times to offer', async () => {
    const { applicationId } = await callable();
    await f.pool.query(
      'UPDATE applications SET stage=$3 WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, applicationId, ApplicationStage.INTERVIEW],
    );
    const booking = await row(
      `INSERT INTO call_requests(tenant_id,application_id,language,status,idempotency_key,purpose,next_attempt_at)
       VALUES($1,$2,'EN','PLANNED',$3,'SCHEDULING',$4) RETURNING id`,
      [f.tenantA, applicationId, randomUUID(), START],
    );
    await dispatch();
    expect(dialFor(booking.id)).toBeUndefined();
    expect(
      await row(
        'SELECT status,failure FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, booking.id],
      ),
    ).toEqual({ status: 'FAILED', failure: 'no_interview_setup' });
    const view = await f
      .authorized('get', `/applications/${applicationId}/calls`)
      .expect(200);
    expect(view.body.calls[0]).toMatchObject({
      purpose: 'SCHEDULING',
      automatic: true,
      failure_message: expect.stringContaining('no interview booking set up'),
    });
  });

  it('checks again before dialing, and hangs up a call a recruiter cancels', async () => {
    const stale = await callable();
    const first = await ask(stale.applicationId);
    await f.pool.query(
      'UPDATE applications SET stage=$3 WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, stale.applicationId, ApplicationStage.REJECTED],
    );
    await dispatch();
    expect(plivo.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(
      await row(
        'SELECT status,outcome,failure FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, first.body.id],
      ),
    ).toEqual({ status: 'FAILED', outcome: 'FAILED', failure: 'not_eligible' });

    const live = await callable();
    const second = await ask(live.applicationId);
    await dispatch();
    await f
      .authorized('post', `/call-requests/${second.body.id}/cancel`)
      .expect(201);
    expect(plivo.at(-1)).toMatchObject({
      method: 'DELETE',
      url: expect.stringMatching(/\/Request\/req-\d+\/$/),
    });
    expect((await attemptOf(second.body.id)).status).toBe('CANCELLED');
    expect(
      await row(
        'SELECT status FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, second.body.id],
      ),
    ).toEqual({ status: 'CANCELLED' });
    await f
      .authorized('post', `/call-requests/${first.body.id}/cancel`)
      .expect(409);
  });

  it('calls a job’s shortlisted candidates who agreed, once each', async () => {
    const { jobId } = await callable();
    const other = randomUUID();
    await f.pool.query(
      "INSERT INTO candidates(id,tenant_id,full_name,email,phone) VALUES($1,$2,'No Consent',$3,'+919800000000')",
      [other, f.tenantA, `${other}@example.test`],
    );
    await f.pool.query(
      'INSERT INTO applications(tenant_id,job_id,candidate_id,stage) VALUES($1,$2,$3,$4)',
      [f.tenantA, jobId, other, ApplicationStage.SHORTLISTED],
    );
    const first = await f
      .authorized('post', `/jobs/${jobId}/calls`)
      .send({ language: 'HI', recording: true })
      .expect(201);
    expect(first.body).toMatchObject({
      planned: 1,
      no_consent: 1,
      already_called: 0,
    });
    const again = await f
      .authorized('post', `/jobs/${jobId}/calls`)
      .send({ language: 'HI' })
      .expect(201);
    expect(again.body).toMatchObject({
      planned: 0,
      no_consent: 1,
      already_called: 1,
    });
    // Asked to record, but the candidate didn't agree to it.
    expect(
      await row(
        'SELECT cr.recording,cr.language FROM call_requests cr JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id WHERE a.tenant_id=$1 AND a.job_id=$2',
        [f.tenantA, jobId],
      ),
    ).toEqual({ recording: false, language: 'HI' });
  });

  it('saves the answers and recording, plays it to recruiters, and erases it with the candidate', async () => {
    const { applicationId, candidateId } = await callable([
      ConsentScope.CALL,
      ConsentScope.RECORDING,
      ConsentScope.TRANSCRIPTION,
    ]);
    const planned = await ask(applicationId, {
      recording: true,
      transcription: true,
    });
    await dispatch();
    const attempt = await attemptOf(planned.body.id);
    expect(attempt).toMatchObject({ recording: true, transcription: true });
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]);
    await f.app!.get(CallRecordsService).finishAttempt(f.tenantA, attempt.id, {
      status: 'COMPLETED',
      outcome: 'COMPLETED',
      answers: [
        {
          question_id: 'q-relocate',
          question: 'Are you open to working from our Noida office?',
          answered: true,
          answer: 'Yes, happy to.',
          value: 'yes',
          expected_answer: 'yes',
          matches_expected: true,
        },
      ],
      summary: 'Answered the question.',
      transcript: [{ speaker: 'candidate', text: 'Yes, happy to.', at: 4000 }],
      recording: wav,
      voiceProvider: 'google_ai',
      voiceModel: 'test-model',
    });
    expect(
      await row(
        'SELECT status,outcome FROM call_requests WHERE tenant_id=$1 AND id=$2',
        [f.tenantA, planned.body.id],
      ),
    ).toEqual({ status: 'COMPLETED', outcome: 'COMPLETED' });
    // The answers are queued for assessment once the call is saved.
    const assessor = f.app!.get(CallAssessmentService);
    expect(assessor.queue).toHaveBeenCalledWith(f.tenantA, attempt.id);
    expect((await attemptOf(planned.body.id)).assessment_status).toBe(
      'PENDING',
    );
    // A yes/no deal-breaker needs no AI: HireAI's own check scores it.
    await assessor.assess(f.tenantA, attempt.id);
    const panel = await f
      .authorized('get', `/applications/${applicationId}/calls`)
      .expect(200);
    expect(panel.body.calls[0].attempt_history[0]).toMatchObject({
      status: 'COMPLETED',
      outcome: 'COMPLETED',
      voice_label: 'Gemini Live',
      summary: 'Answered the question.',
      has_recording: true,
      transcript: [{ speaker: 'candidate', text: 'Yes, happy to.', at: 4000 }],
      answers: [expect.objectContaining({ matches_expected: true })],
      assessment_status: 'COMPLETED',
      assessment: {
        score: 100,
        fit: 'STRONG',
        deal_breaker: false,
        answers: [expect.objectContaining({ rating: 'STRONG' })],
      },
      assessment_failure: null,
    });
    await f
      .authorized(
        'post',
        `/call-requests/${planned.body.id}/attempts/${attempt.id}/assessment`,
      )
      .expect(201, { assessment_status: 'PENDING' });
    const recordingPath = `/call-requests/${planned.body.id}/attempts/${attempt.id}/recording`;
    const played = await f
      .authorized('get', recordingPath)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(played.headers['content-type']).toBe('audio/wav');
    expect(Buffer.compare(played.body, wav)).toBe(0);

    await f.authorized('post', `/candidates/${candidateId}/erase`).expect(200);
    expect(
      (
        await f.pool.query(
          'SELECT id FROM call_attempts WHERE tenant_id=$1 AND call_request_id=$2',
          [f.tenantA, planned.body.id],
        )
      ).rows,
    ).toEqual([]);
    await f.authorized('get', recordingPath).expect(404);
  });

  it('starts browser test calls only with a voice AI and the job’s questions', async () => {
    const { jobId } = await callable();
    const started = await f
      .authorized('post', '/calls/test-sessions')
      .send({ jobId, language: 'EN' })
      .expect(201);
    expect(started.body).toMatchObject({
      ticket: expect.any(String),
      voice: 'Gemini Live',
      sample_rate: 16000,
      max_seconds: 300,
    });
    await f.pool.query(
      'UPDATE jobs SET call_questions=$3 WHERE tenant_id=$1 AND id=$2',
      [f.tenantA, jobId, '[]'],
    );
    await f
      .authorized('post', '/calls/test-sessions')
      .send({ jobId, language: 'EN' })
      .expect(409);
  });

  it('introduces the AI by the chosen name and asks for the candidate by first name', async () => {
    const { jobId, applicationId } = await callable();
    await f.pool.query(
      'UPDATE organization_ai_settings SET calling_assistant_name=$2 WHERE tenant_id=$1',
      [f.tenantA, 'Priya'],
    );
    try {
      const setup = await runWithTenant(f.tenantA, () =>
        phoneCallSetup(
          f.app!.get(DbService),
          f.tenantA,
          { application_id: applicationId, language: 'EN', questions: [] },
          { recording: false, transcription: false },
        ),
      );
      expect(setup).toMatchObject({
        assistantName: 'Priya',
        candidateFirstName: 'Scenario',
      });
      // In a test call, the recruiter trying it is asked for by name.
      const started = await f
        .authorized('post', '/calls/test-sessions')
        .send({ jobId, language: 'EN' })
        .expect(201);
      expect(
        f.app!.get(TestCallsService).take(started.body.ticket)?.setup,
      ).toMatchObject({ assistantName: 'Priya', candidateFirstName: 'Test' });
    } finally {
      await f.pool.query(
        'UPDATE organization_ai_settings SET calling_assistant_name=NULL WHERE tenant_id=$1',
        [f.tenantA],
      );
    }
  });

  it('refuses audio streams without a valid call address or ticket', async () => {
    const server: Server = f.app!.getHttpServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const status = (path: string) =>
        new Promise<number>((resolve) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
          socket.on('unexpected-response', (_req, res) =>
            resolve(res.statusCode ?? 0),
          );
          socket.on('open', () => {
            socket.close();
            resolve(101);
          });
          socket.on('error', () => undefined);
        });
      expect(
        await status(
          `${api}/public/calls/plivo/stream/${f.tenantA}/${randomUUID()}/forged-token-forged-token`,
        ),
      ).toBe(403);
      expect(
        await status(`${api}/calls/test/unknown-ticket-unknown-ticket`),
      ).toBe(403);
      expect(await status(`${api}/elsewhere`)).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
