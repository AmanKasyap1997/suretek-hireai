import { useApiFixture } from '../helpers/api-fixtures';
import { randomUUID } from 'node:crypto';
import { CallingClock } from '../../src/modules/talent-acquisition';
import {
  ConsentScope,
  CallLanguage,
  CallRequestStatus,
} from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('requires separate recording consent, preserves call idempotency and cancels on revocation', async () => {
    const { pool, tenantA, authorized, scenario } = fixture;
    const { candidateId, applicationId } = await scenario();
    const body = {
      applicationId,
      language: CallLanguage.EN,
      recording: true,
      transcription: false,
      idempotencyKey: randomUUID(),
    };
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.CALL,
        granted: true,
        source: 'Candidate opt-in form ref-123',
      })
      .expect(201);
    await authorized('post', '/call-requests').send(body).expect(403);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.RECORDING,
        granted: true,
        source: 'Recording opt-in form ref-124',
      })
      .expect(201);
    const planned = await authorized('post', '/call-requests')
      .send(body)
      .expect(201);
    const retry = await authorized('post', '/call-requests')
      .send(body)
      .expect(201);
    expect(retry.body.id).toBe(planned.body.id);
    await authorized('post', '/call-requests')
      .send({ ...body, language: CallLanguage.HI })
      .expect(409);
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.RECORDING,
        granted: false,
        source: 'Candidate withdrawal email ref-125',
      })
      .expect(201);
    const cancelled = await pool.query(
      'SELECT status FROM call_requests WHERE tenant_id=$1 AND id=$2',
      [tenantA, planned.body.id],
    );
    expect(cancelled.rows[0].status).toBe(CallRequestStatus.CANCELLED);
    await authorized('post', '/call-requests')
      .send({ ...body, idempotencyKey: randomUUID() })
      .expect(403);
    const consentHistory = await authorized(
      'get',
      `/candidates/${candidateId}/consents`,
    ).expect(200);
    expect(consentHistory.body.data).toHaveLength(3);
    expect(
      consentHistory.body.latest.find(
        (consent: { scope: string }) =>
          consent.scope === ConsentScope.RECORDING,
      ).granted,
    ).toBe(false);
  });

  it('schedules a call asked for outside calling hours for when they open', async () => {
    const { app, authorized, scenario } = fixture;
    const { candidateId, applicationId } = await scenario();
    await authorized('post', `/candidates/${candidateId}/consents`)
      .send({
        scope: ConsentScope.CALL,
        granted: true,
        source: 'Candidate opt-in form ref-126',
      })
      .expect(201);
    const clock = app!.get(CallingClock);
    jest.spyOn(clock, 'now').mockReturnValue(new Date('2026-01-01T18:00:00Z'));
    try {
      const planned = await authorized('post', '/call-requests')
        .send({
          applicationId,
          language: CallLanguage.EN,
          recording: false,
          transcription: false,
          idempotencyKey: randomUUID(),
        })
        .expect(201);
      expect(planned.body.status).toBe(CallRequestStatus.PLANNED);
      expect(planned.body.next_attempt_at).toBe('2026-01-02T09:00:00.000Z');
      // One active call per application.
      await authorized('post', '/call-requests')
        .send({
          applicationId,
          language: CallLanguage.EN,
          idempotencyKey: randomUUID(),
        })
        .expect(409);
    } finally {
      jest
        .spyOn(clock, 'now')
        .mockReturnValue(new Date('2026-01-01T10:00:00Z'));
    }
  });
});
