import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { readConfig } from '../../../platform/config';
import { DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import {
  PlivoCredentials,
  plivoCredentials,
  plivoHangUp,
  plivoHangupXml,
  plivoSignatureValid,
  plivoStreamXml,
} from '../../organization-integrations/plivo';
import { Resampler, mulawToPcm, pcmToMulaw } from './audio';
import { CallConversation, PhoneLeg } from './call-conversation';
import { callLinks, publicApiOrigin } from './call-links';
import { CallRecordsService } from './call-records.service';
import { CallDispatchService } from './call-dispatch.service';
import { InterviewBookingService } from './interview-booking';
import { CallQuestion } from './call-script';
import { phoneCallSetup, voiceOptions } from './call-setup';

interface AttemptContext {
  id: string;
  status: string;
  request_status: string;
  application_id: string;
  language: 'EN' | 'HI';
  questions: CallQuestion[];
  purpose: string;
  slots: { id: string; label: string }[] | null;
  recording: boolean;
  transcription: boolean;
  provider_request_id: string | null;
  provider_call_id: string | null;
  environment: string;
  encrypted_credentials: string;
}

export interface PlivoWebhook {
  tenantId: string;
  attemptId: string;
  /** The path and query Plivo requested, e.g. /api/v1/public/...?token=... */
  path: string;
  params: Record<string, unknown>;
  nonce?: string;
  signatures: (string | undefined)[];
}

/** Plivo's audio stream for one call, as the candidate's side of a conversation. */
class PlivoLeg implements PhoneLeg {
  private readonly toPhone = new Resampler(16000, 8000);
  private streamId: string | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly hangUpCall: () => Promise<void>,
  ) {}

  started(streamId: unknown) {
    if (typeof streamId === 'string') this.streamId = streamId;
  }

  private send(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  play(pcm16k: Buffer) {
    const audio = pcmToMulaw(this.toPhone.push(pcm16k));
    if (audio.length)
      this.send({
        event: 'playAudio',
        media: {
          contentType: 'audio/x-mulaw',
          sampleRate: 8000,
          payload: audio.toString('base64'),
        },
      });
  }

  clear() {
    this.send({ event: 'clearAudio', streamId: this.streamId });
  }

  hangUp() {
    void this.hangUpCall();
    setTimeout(() => this.socket.close(1000), 2000).unref();
  }
}

/** Live phone calls: Plivo's webhooks and audio streams. */
@Injectable()
export class PhoneCallsService {
  private readonly logger = new Logger(PhoneCallsService.name);
  /** Conversations on the line in this process, by attempt id. */
  private readonly live = new Map<string, CallConversation>();

  constructor(
    private readonly db: DbService,
    private readonly records: CallRecordsService,
    private readonly booking: InterviewBookingService,
    private readonly dispatcher: CallDispatchService,
  ) {}

  private attempt(tenantId: string, attemptId: string) {
    return this.db.one<AttemptContext>(
      `SELECT ca.id,ca.status,cr.status AS request_status,cr.application_id,cr.language,cr.questions,
         cr.purpose,ca.slots,ca.recording,ca.transcription,ca.provider_request_id,ca.provider_call_id,
         ic.environment,ic.encrypted_credentials
       FROM call_attempts ca
       JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       JOIN integration_configs ic ON ic.tenant_id=ca.tenant_id AND ic.id=ca.connection_id
       WHERE ca.tenant_id=$1 AND ca.id=$2`,
      [tenantId, attemptId],
    );
  }

  private credentials(tenantId: string, attempt: AttemptContext) {
    return plivoCredentials(
      tenantId,
      attempt.environment,
      attempt.encrypted_credentials,
    );
  }

  /** Is this request really from Plivo, for this call's account? */
  private signed(webhook: PlivoWebhook, credentials: PlivoCredentials | null) {
    const origin = publicApiOrigin();
    return (
      !!origin &&
      !!credentials &&
      plivoSignatureValid({
        url: origin + webhook.path,
        params: webhook.params,
        nonce: webhook.nonce,
        signatures: webhook.signatures,
        authToken: credentials.authToken,
      })
    );
  }

  /**
   * The candidate picked up: stream the call's audio to HireAI. Returns
   * null when the request isn't a genuine Plivo webhook for this call.
   */
  answer(webhook: PlivoWebhook): Promise<string | null> {
    return runWithTenant(webhook.tenantId, async () => {
      const attempt = await this.attempt(webhook.tenantId, webhook.attemptId);
      if (!attempt) return null;
      if (!this.signed(webhook, this.credentials(webhook.tenantId, attempt)))
        return null;
      const callId =
        typeof webhook.params.CallUUID === 'string'
          ? webhook.params.CallUUID.slice(0, 100)
          : null;
      const links = callLinks(webhook.tenantId, webhook.attemptId);
      const updated =
        links &&
        attempt.request_status === 'IN_PROGRESS' &&
        (await this.db.one(
          `UPDATE call_attempts SET status='IN_PROGRESS',answered_at=now(),
             provider_call_id=coalesce($3,provider_call_id),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='DIALING' RETURNING id`,
          [webhook.tenantId, webhook.attemptId, callId],
        ));
      return updated
        ? plivoStreamXml(links.streamUrl, readConfig().CALL_MAX_SECONDS)
        : plivoHangupXml;
    });
  }

  /** The call ended (or was never answered). */
  hangup(webhook: PlivoWebhook): Promise<boolean> {
    return runWithTenant(webhook.tenantId, async () => {
      const attempt = await this.attempt(webhook.tenantId, webhook.attemptId);
      if (!attempt) return false;
      if (!this.signed(webhook, this.credentials(webhook.tenantId, attempt)))
        return false;
      const p = webhook.params;
      const text = (v: unknown) =>
        typeof v === 'string' && v ? v.slice(0, 100) : null;
      const cause = text(p.HangupCauseName) ?? text(p.HangupCause);
      const answered = Date.parse(String(p.AnswerTime ?? ''));
      const ended = Date.parse(String(p.EndTime ?? ''));
      const duration =
        Number.isFinite(answered) && Number.isFinite(ended) && ended >= answered
          ? Math.round((ended - answered) / 1000)
          : Number.isFinite(Number(p.Duration))
            ? Math.max(0, Math.round(Number(p.Duration)))
            : null;
      const conversation = this.live.get(webhook.attemptId);
      if (conversation) {
        // The conversation saves the result when it closes.
        await this.db.query(
          `UPDATE call_attempts SET hangup_cause=$3,duration_seconds=coalesce($4,duration_seconds),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [webhook.tenantId, webhook.attemptId, cause, duration],
        );
        conversation.legClosed();
        return true;
      }
      const invalid = /unallocated|invalid|not.?exist|no.?route/i.test(
        cause ?? '',
      );
      // The call already ended in HireAI: only the timing and cause are new.
      if (!['DIALING', 'IN_PROGRESS'].includes(attempt.status)) {
        await this.records.finishAttempt(webhook.tenantId, webhook.attemptId, {
          status: 'COMPLETED',
          hangupCause: cause,
          durationSeconds: duration,
        });
        return true;
      }
      await this.records.finishAttempt(
        webhook.tenantId,
        webhook.attemptId,
        attempt.status === 'IN_PROGRESS'
          ? {
              status: 'FAILED',
              failure: 'stream_failed',
              retry: true,
              hangupCause: cause,
              durationSeconds: duration,
            }
          : invalid
            ? {
                status: 'FAILED',
                failure: 'invalid_number',
                hangupCause: cause,
              }
            : { status: 'NO_ANSWER', hangupCause: cause, durationSeconds: 0 },
      );
      this.dispatcher.wake();
      return true;
    });
  }

  /**
   * Plivo opened the call's audio stream: start the AI conversation and save
   * its result when it ends.
   */
  connect(tenantId: string, attemptId: string, socket: WebSocket) {
    void runWithTenant(tenantId, async () => {
      const attempt = await this.attempt(tenantId, attemptId);
      const credentials = attempt && this.credentials(tenantId, attempt);
      const setup =
        attempt?.status === 'IN_PROGRESS' &&
        attempt.request_status === 'IN_PROGRESS' &&
        !this.live.has(attemptId) &&
        (await phoneCallSetup(this.db, tenantId, attempt, attempt));
      if (!attempt || !credentials || !setup) {
        socket.close(1008);
        if (attempt && credentials)
          await plivoHangUp(credentials, {
            callId: attempt.provider_call_id,
            requestId: attempt.provider_request_id,
          });
        return;
      }
      const hangUp = async () => {
        const current = await runWithTenant(tenantId, () =>
          this.attempt(tenantId, attemptId),
        );
        await plivoHangUp(credentials, {
          callId: current?.provider_call_id ?? attempt.provider_call_id,
          requestId: attempt.provider_request_id,
        });
      };
      const leg = new PlivoLeg(socket, hangUp);
      const conversation = new CallConversation(
        setup,
        await voiceOptions(this.db, tenantId),
        leg,
        Date.now,
        {
          // A booking call books the time the candidate picks.
          book: (slotId) =>
            runWithTenant(tenantId, () =>
              this.booking.book(tenantId, attemptId, slotId),
            ),
        },
      );
      this.live.set(attemptId, conversation);
      const fromPhone = new Resampler(8000, 16000);
      socket.on('message', (data, binary) => {
        if (binary) return;
        let message: Record<string, any>;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.event === 'start') leg.started(message.start?.streamId);
        else if (message.event === 'media' && message.media?.payload) {
          if (message.media.track && message.media.track !== 'inbound') return;
          conversation.candidateAudio(
            fromPhone.push(
              mulawToPcm(Buffer.from(String(message.media.payload), 'base64')),
            ),
          );
        } else if (message.event === 'stop') conversation.legClosed();
      });
      socket.on('close', () => conversation.legClosed());
      socket.on('error', () => conversation.legClosed());
      try {
        await conversation.start();
        const result = await conversation.done;
        if (result.aiAudioSpeed !== null)
          this.logger[result.aiAudioSpeed < 1 ? 'warn' : 'log'](
            `AI speech arrived at ${result.aiAudioSpeed}x real time${
              result.aiAudioSpeed < 1
                ? ' (slower than it plays: the voice breaks up)'
                : ''
            } (${result.voiceProvider} ${result.voiceModel})`,
          );
        // If only the audio link dropped, the call itself may still be up.
        if (result.reason === 'candidate') void hangUp().catch(() => undefined);
        const connected = !!result.voiceProvider;
        await this.records.finishAttempt(tenantId, attemptId, {
          status: connected ? 'COMPLETED' : 'FAILED',
          outcome: connected ? result.outcome : null,
          answers: result.answers,
          summary: result.summary,
          callbackNote: result.callbackNote,
          callbackAt: result.callbackAt,
          transcript: result.transcript,
          recording: result.recording,
          voiceProvider: result.voiceProvider,
          voiceModel: result.voiceModel,
          failure: result.failure,
          durationSeconds: result.seconds,
          // The voice AI was busy (e.g. too many sessions at once) or
          // unreachable: call again later. A key or model problem isn't.
          retry:
            !connected &&
            result.voiceFailures.length > 0 &&
            result.voiceFailures.every(
              (f) => f.reason === 'network' || f.reason === 'quota',
            ),
        });
        if (result.voiceFailures.length)
          this.logger.warn(
            `Voice AI unavailable on a call: ${result.voiceFailures
              .map((f) => `${f.provider} (${f.reason})`)
              .join(', ')}`,
          );
      } catch {
        this.logger.warn('A phone call’s result couldn’t be saved');
      } finally {
        this.live.delete(attemptId);
        // A line is free: the next call in the queue needn't wait.
        this.dispatcher.wake();
      }
    });
  }

  /** A recruiter cancelled a call that's on the line. */
  async cancel(tenantId: string, requestId: string) {
    const attempts = await this.db.query<{
      id: string;
      provider_call_id: string | null;
      provider_request_id: string | null;
      environment: string;
      encrypted_credentials: string;
    }>(
      `SELECT ca.id,ca.provider_call_id,ca.provider_request_id,ic.environment,ic.encrypted_credentials
       FROM call_attempts ca JOIN integration_configs ic ON ic.tenant_id=ca.tenant_id AND ic.id=ca.connection_id
       WHERE ca.tenant_id=$1 AND ca.call_request_id=$2 AND ca.status IN ('DIALING','IN_PROGRESS')`,
      [tenantId, requestId],
    );
    for (const attempt of attempts) {
      const conversation = this.live.get(attempt.id);
      if (conversation) conversation.cancel();
      const credentials = plivoCredentials(
        tenantId,
        attempt.environment,
        attempt.encrypted_credentials,
      );
      if (credentials)
        await plivoHangUp(credentials, {
          callId: attempt.provider_call_id,
          requestId: attempt.provider_request_id,
        });
      if (!conversation)
        await this.records.finishAttempt(tenantId, attempt.id, {
          status: 'CANCELLED',
        });
    }
  }
}
