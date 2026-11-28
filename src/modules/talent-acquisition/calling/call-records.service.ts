import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit } from '../../../platform/audit/audit';
import { readConfig } from '../../../platform/config';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { CallRecordingStorage } from '../../../integrations';
import { Actor } from '../../../shared/actor';
import { CallRequestStatus } from '../../../shared/enums';
import { callingProviderLabels } from '../../organization-integrations/organization-ai';
import { nextCallingTime } from './calling.policy';
import { CallingClock } from './calling.clock';
import { AttemptOutcome, CallAnswer, TranscriptLine } from './call-script';
import { callFailureMessage, callingRules } from './call-setup';
import {
  CallAssessmentService,
  assessmentFailureMessages,
} from './call-assessment.service';
import type { CallAssessment } from './call-assessment';

export type AttemptStatus =
  | 'DIALING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'NO_ANSWER'
  | 'FAILED'
  | 'CANCELLED';
const FINAL: AttemptStatus[] = [
  'COMPLETED',
  'NO_ANSWER',
  'FAILED',
  'CANCELLED',
];

/** An assessment still pending after this long has stalled (e.g. a restart). */
const ASSESSMENT_STALL_MS = 10 * 60_000;

function assessmentView(a: {
  assessment: (CallAssessment & { failure?: string }) | null;
  assessment_status: 'PENDING' | 'COMPLETED' | 'FAILED' | null;
  updated_at: Date;
}) {
  const stalled =
    a.assessment_status === 'PENDING' &&
    Date.now() - new Date(a.updated_at).getTime() > ASSESSMENT_STALL_MS;
  const status = stalled ? 'FAILED' : a.assessment_status;
  return {
    assessment_status: status,
    assessment: status === 'COMPLETED' ? a.assessment : null,
    assessment_failure:
      status === 'FAILED'
        ? (assessmentFailureMessages[
            stalled ? 'stalled' : (a.assessment?.failure ?? 'unavailable')
          ] ?? assessmentFailureMessages.unavailable)
        : null,
  };
}

/** How one dialing attempt ended. */
export interface AttemptEnd {
  status: 'COMPLETED' | 'NO_ANSWER' | 'FAILED' | 'CANCELLED';
  outcome?: AttemptOutcome | null;
  answers?: CallAnswer[];
  summary?: string | null;
  callbackNote?: string | null;
  /** The time the candidate agreed to be called back, if the AI gave one. */
  callbackAt?: Date | null;
  transcript?: TranscriptLine[] | null;
  /** WAV bytes, kept only when the attempt was allowed to record. */
  recording?: Buffer | null;
  voiceProvider?: string | null;
  voiceModel?: string | null;
  failure?: string | null;
  hangupCause?: string | null;
  durationSeconds?: number | null;
  /** A technical failure that another attempt may get past. */
  retry?: boolean;
}

/**
 * Call-backs a candidate may ask for within one call request. They don't use
 * up its attempts: those are for calls nobody answered.
 */
export const MAX_CALL_BACKS = 2;
/** How far ahead a call-back may be booked. */
const CALL_BACK_DAYS = 14;

/**
 * When to call back at the candidate's request: the agreed time, at least
 * five minutes from now. null (the usual retry delay) for a time in the past,
 * such as a misheard one, or more than CALL_BACK_DAYS ahead.
 */
export function callBackAt(requested: Date | null | undefined, now: Date) {
  if (!requested) return null;
  const at = requested.getTime();
  const from = now.getTime();
  if (at < from - 60_000 || at > from + CALL_BACK_DAYS * 86_400_000)
    return null;
  return new Date(Math.max(at, from + 5 * 60_000));
}

/** Attempt outcomes that end the call request. */
const FINAL_OUTCOMES: AttemptOutcome[] = [
  'COMPLETED',
  'DECLINED',
  'WRONG_PERSON',
];

interface AttemptRow {
  id: string;
  call_request_id: string;
  number: number;
  status: AttemptStatus;
  recording: boolean;
  transcription: boolean;
  request_status: CallRequestStatus;
  attempts: number;
  max_attempts: number;
}

@Injectable()
export class CallRecordsService {
  private readonly logger = new Logger(CallRecordsService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: CallRecordingStorage,
    private readonly clock: CallingClock,
    private readonly assessor: CallAssessmentService,
  ) {}

  /**
   * Saves how an attempt ended and moves the call request on: done, another
   * attempt later, or failed. Does nothing for an attempt that already ended.
   */
  async finishAttempt(tenantId: string, attemptId: string, end: AttemptEnd) {
    return runWithTenant(tenantId, async () => {
      let stored: {
        key: string;
        version: string | null;
        bytes: number;
      } | null = null;
      if (end.recording?.length) {
        const key = `${tenantId}/${randomUUID()}`;
        try {
          const version = await this.storage.put(
            key,
            end.recording,
            'audio/wav',
          );
          stored = {
            key,
            version: version ?? null,
            bytes: end.recording.length,
          };
        } catch {
          this.logger.warn('A call recording couldn’t be stored');
        }
      }
      let kept = false;
      let assess = false;
      try {
        const settled = await this.db.transaction((tx) =>
          this.settle(tx, tenantId, attemptId, end, stored),
        );
        kept = settled.kept;
        assess = settled.assess;
      } finally {
        if (stored && !kept) await this.removeRecording(stored);
      }
      if (assess) this.assessor.queue(tenantId, attemptId);
    });
  }

  private async removeRecording(stored: {
    key: string;
    version: string | null;
  }) {
    try {
      await this.storage.delete(stored.key, stored.version ?? undefined);
    } catch {
      this.logger.warn(
        'An unused call recording couldn’t be deleted; reconcile private storage',
      );
    }
  }

  private async settle(
    tx: DbClient,
    tenantId: string,
    attemptId: string,
    end: AttemptEnd,
    stored: { key: string; version: string | null; bytes: number } | null,
  ): Promise<{ kept: boolean; assess: boolean }> {
    const attempt = await tx.one<AttemptRow>(
      `SELECT ca.id,ca.call_request_id,ca.number,ca.status,ca.recording,ca.transcription,
         cr.status AS request_status,cr.attempts,cr.max_attempts
       FROM call_attempts ca JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       WHERE ca.tenant_id=$1 AND ca.id=$2 FOR UPDATE OF ca,cr`,
      [tenantId, attemptId],
    );
    if (!attempt) return { kept: false, assess: false };
    if (FINAL.includes(attempt.status)) {
      // Late details (e.g. Plivo's hangup after the AI ended the call).
      await tx.query(
        `UPDATE call_attempts SET duration_seconds=coalesce($3,duration_seconds),
           hangup_cause=coalesce($4,hangup_cause),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          attemptId,
          end.durationSeconds ?? null,
          end.hangupCause ?? null,
        ],
      );
      return { kept: false, assess: false };
    }
    const keepRecording = !!stored && attempt.recording;
    // Answers are assessed after the call (the screening AI rates them).
    const assess = end.status === 'COMPLETED' && !!end.answers?.length;
    await tx.query(
      `UPDATE call_attempts SET status=$3,outcome=$4,answers=$5,summary=$6,callback_note=$7,
         transcript=$8,recording_key=$9,recording_version=$10,recording_bytes=$11,failure=$12,
         voice_provider=coalesce($13,voice_provider),voice_model=coalesce($14,voice_model),
         hangup_cause=coalesce($15,hangup_cause),duration_seconds=coalesce($16,duration_seconds),
         assessment_status=CASE WHEN $17 THEN 'PENDING' END,
         ended_at=coalesce(ended_at,now()),updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        tenantId,
        attemptId,
        end.status,
        end.outcome ?? null,
        end.answers ? JSON.stringify(end.answers) : null,
        end.summary ?? null,
        end.callbackNote ?? null,
        attempt.transcription && end.transcript
          ? JSON.stringify(end.transcript)
          : null,
        keepRecording ? stored!.key : null,
        keepRecording ? stored!.version : null,
        keepRecording ? stored!.bytes : null,
        end.status === 'FAILED' ? (end.failure ?? 'no_result') : null,
        end.voiceProvider ?? null,
        end.voiceModel ?? null,
        end.hangupCause ?? null,
        end.durationSeconds ?? null,
        assess,
      ],
    );
    const evidence = { tenantId, userId: null };
    await audit(
      tx,
      evidence,
      'call.attempt_ended',
      'call_request',
      attempt.call_request_id,
      {
        attempt: attempt.number,
        status: end.status,
        outcome: end.outcome ?? null,
        failure: end.status === 'FAILED' ? (end.failure ?? 'no_result') : null,
        answers: end.answers?.length ?? 0,
        recording: keepRecording,
      },
    );
    if (attempt.request_status !== CallRequestStatus.IN_PROGRESS)
      return { kept: keepRecording, assess };

    const done =
      end.status === 'COMPLETED' &&
      !!end.outcome &&
      FINAL_OUTCOMES.includes(end.outcome);
    const retryable =
      end.status === 'NO_ANSWER' ||
      (end.status === 'COMPLETED' && !done) ||
      (end.status === 'FAILED' && !!end.retry);
    // Call-backs the candidate asked for (this one included) don't use up
    // the attempts, up to MAX_CALL_BACKS of them.
    const callBack = end.status === 'COMPLETED' && end.outcome === 'CALL_BACK';
    const callBacks = retryable
      ? Number(
          (await tx.one<{ total: string }>(
            "SELECT count(*) AS total FROM call_attempts WHERE tenant_id=$1 AND call_request_id=$2 AND outcome='CALL_BACK'",
            [tenantId, attempt.call_request_id],
          ))!.total,
        )
      : 0;
    const asked = callBack && callBacks <= MAX_CALL_BACKS;
    const another =
      retryable &&
      (asked ||
        attempt.attempts - Math.min(callBacks, MAX_CALL_BACKS) <
          attempt.max_attempts);
    if (done) {
      await tx.query(
        `UPDATE call_requests SET status='COMPLETED',outcome=$3,failure=NULL,completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, attempt.call_request_id, end.outcome],
      );
      await audit(
        tx,
        evidence,
        'call.completed',
        'call_request',
        attempt.call_request_id,
        {
          outcome: end.outcome,
        },
      );
    } else if (another) {
      const rules = await callingRules(tx);
      const now = this.clock.now();
      // The time the candidate asked for, else the usual retry delay; either
      // way within calling hours.
      const requested = asked ? callBackAt(end.callbackAt, now) : null;
      const later =
        requested ??
        new Date(now.getTime() + readConfig().CALL_RETRY_MINUTES * 60_000);
      const next = nextCallingTime(rules.policies, later) ?? later;
      await tx.query(
        `UPDATE call_requests SET status='PLANNED',next_attempt_at=$3,failure=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          attempt.call_request_id,
          next,
          end.status === 'FAILED' ? (end.failure ?? null) : null,
        ],
      );
      if (asked)
        await audit(
          tx,
          evidence,
          'call.call_back_planned',
          'call_request',
          attempt.call_request_id,
          { at: next.toISOString(), requestedTime: !!requested },
        );
    } else {
      const unreached = retryable && end.status !== 'FAILED';
      await tx.query(
        `UPDATE call_requests SET status='FAILED',outcome=$3,failure=$4,completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          attempt.call_request_id,
          unreached ? 'UNREACHED' : 'FAILED',
          unreached ? 'unreached' : (end.failure ?? 'no_result'),
        ],
      );
      await audit(
        tx,
        evidence,
        'call.failed',
        'call_request',
        attempt.call_request_id,
        {
          outcome: unreached ? 'UNREACHED' : 'FAILED',
        },
      );
    }
    return { kept: keepRecording, assess };
  }

  /** Runs a call's assessment again (e.g. after the AI provider failed). */
  async reassess(actor: Actor, requestId: string, attemptId: string) {
    const row = await this.db.one<{ id: string }>(
      `SELECT ca.id FROM call_attempts ca
       JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.erased_at IS NULL
       WHERE ca.tenant_id=$1 AND ca.call_request_id=$2 AND ca.id=$3 AND ca.status='COMPLETED'
         AND jsonb_array_length(coalesce(ca.answers,'[]'))>0`,
      [actor.tenantId, requestId, attemptId],
    );
    if (!row) throw new NotFoundException('No answers to assess on this call');
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE call_attempts SET assessment_status='PENDING',updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, attemptId],
      );
      await audit(
        tx,
        actor,
        'call.assessment_requested',
        'call_request',
        requestId,
      );
    });
    this.assessor.queue(actor.tenantId, attemptId);
    return { assessment_status: 'PENDING' };
  }

  /** An application's calls, newest first, for recruiters. */
  async applicationCalls(db: DbClient, actor: Actor, applicationId: string) {
    const requests = await db.query<{
      id: string;
      status: CallRequestStatus;
      outcome: string | null;
      failure: string | null;
      language: string;
      recording: boolean;
      transcription: boolean;
      questions: unknown[];
      attempts: number;
      max_attempts: number;
      next_attempt_at: Date | null;
      created_at: Date;
      completed_at: Date | null;
      requested_by_name: string | null;
      purpose: 'SCREENING' | 'SCHEDULING';
      automatic: boolean;
    }>(
      `SELECT cr.id,cr.status,cr.outcome,cr.failure,cr.language,cr.recording,cr.transcription,cr.questions,
         cr.attempts,cr.max_attempts,cr.next_attempt_at,cr.created_at,cr.completed_at,u.full_name AS requested_by_name,
         cr.purpose,cr.requested_by IS NULL AS automatic
       FROM call_requests cr LEFT JOIN users u ON u.tenant_id=cr.tenant_id AND u.id=cr.requested_by
       WHERE cr.tenant_id=$1 AND cr.application_id=$2 ORDER BY cr.created_at DESC,cr.id DESC LIMIT 10`,
      [actor.tenantId, applicationId],
    );
    const attempts = requests.length
      ? await db.query<{
          id: string;
          call_request_id: string;
          number: number;
          status: AttemptStatus;
          voice_provider: 'openai' | 'google_ai' | null;
          answered_at: Date | null;
          ended_at: Date | null;
          duration_seconds: number | null;
          outcome: AttemptOutcome | null;
          answers: CallAnswer[] | null;
          summary: string | null;
          callback_note: string | null;
          transcript: TranscriptLine[] | null;
          recording_key: string | null;
          failure: string | null;
          assessment: (CallAssessment & { failure?: string }) | null;
          assessment_status: 'PENDING' | 'COMPLETED' | 'FAILED' | null;
          updated_at: Date;
          created_at: Date;
          slots: { id: string; label: string }[] | null;
          booked_starts_at: Date | null;
          booked_mode: string | null;
          booked_meeting_url: string | null;
          booked_location: string | null;
          booked_status: string | null;
        }>(
          `SELECT ca.id,ca.call_request_id,ca.number,ca.status,ca.voice_provider,ca.answered_at,ca.ended_at,ca.duration_seconds,
             ca.outcome,ca.answers,ca.summary,ca.callback_note,ca.transcript,ca.recording_key,ca.failure,
             ca.assessment,ca.assessment_status,ca.updated_at,ca.created_at,ca.slots,
             i.starts_at AS booked_starts_at,i.mode AS booked_mode,i.meeting_url AS booked_meeting_url,
             i.location AS booked_location,i.status AS booked_status
           FROM call_attempts ca
           LEFT JOIN interviews i ON i.tenant_id=ca.tenant_id AND i.id=ca.booked_interview_id
           WHERE ca.tenant_id=$1 AND ca.call_request_id=ANY($2::uuid[])
           ORDER BY ca.number`,
          [actor.tenantId, requests.map((r) => r.id)],
        )
      : [];
    return requests.map((request) => ({
      id: request.id,
      status: request.status,
      outcome: request.outcome,
      failure_message:
        request.status === CallRequestStatus.PLANNED && request.failure
          ? `The last attempt failed: ${callFailureMessage(request.failure)}`
          : request.status === CallRequestStatus.FAILED
            ? callFailureMessage(request.failure)
            : null,
      language: request.language,
      recording: request.recording,
      transcription: request.transcription,
      question_count: request.questions.length,
      attempts: request.attempts,
      // Call-backs the candidate asked for come on top of the attempts.
      max_attempts:
        request.max_attempts +
        Math.min(
          attempts.filter(
            (a) =>
              a.call_request_id === request.id && a.outcome === 'CALL_BACK',
          ).length,
          MAX_CALL_BACKS,
        ),
      // Requests from before calls could be placed are never dialed.
      scheduled:
        request.status !== CallRequestStatus.PLANNED ||
        !!request.next_attempt_at,
      next_attempt_at: request.next_attempt_at,
      created_at: request.created_at,
      completed_at: request.completed_at,
      requested_by_name: request.requested_by_name,
      /** SCHEDULING: the call that books the interview. */
      purpose: request.purpose,
      /** Placed by HireAI itself (an automatic step), not a person. */
      automatic: request.automatic,
      attempt_history: attempts
        .filter((a) => a.call_request_id === request.id)
        .map((a) => ({
          id: a.id,
          number: a.number,
          status: a.status,
          voice_label: a.voice_provider
            ? callingProviderLabels[a.voice_provider]
            : null,
          answered_at: a.answered_at,
          ended_at: a.ended_at,
          duration_seconds: a.duration_seconds,
          outcome: a.outcome,
          answers: a.answers ?? [],
          summary: a.summary,
          callback_note: a.callback_note,
          transcript: a.transcript,
          has_recording: !!a.recording_key,
          failure_message:
            a.status === 'FAILED' ? callFailureMessage(a.failure) : null,
          ...assessmentView(a),
          // A booking call: the times offered and the interview booked.
          offered_slots: a.slots?.map((s) => s.label) ?? [],
          booked_interview: a.booked_starts_at
            ? {
                starts_at: a.booked_starts_at,
                mode: a.booked_mode,
                meeting_url: a.booked_meeting_url,
                location: a.booked_location,
                status: a.booked_status,
              }
            : null,
          created_at: a.created_at,
        })),
    }));
  }

  /** A call recording, for HR Admins and recruiters. */
  async recording(actor: Actor, requestId: string, attemptId: string) {
    const row = await this.db.one<{
      recording_key: string | null;
      recording_version: string | null;
      number: number;
    }>(
      `SELECT ca.recording_key,ca.recording_version,ca.number FROM call_attempts ca
       JOIN call_requests cr ON cr.tenant_id=ca.tenant_id AND cr.id=ca.call_request_id
       JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
       JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.erased_at IS NULL
       WHERE ca.tenant_id=$1 AND ca.call_request_id=$2 AND ca.id=$3`,
      [actor.tenantId, requestId, attemptId],
    );
    if (!row?.recording_key) throw new NotFoundException('Recording not found');
    const bytes = await this.storage.get(
      row.recording_key,
      row.recording_version ?? undefined,
    );
    await this.db.transaction((tx) =>
      audit(tx, actor, 'call.recording_played', 'call_request', requestId, {
        attempt: row.number,
      }),
    );
    return bytes;
  }

  /** Deletes a candidate's call recordings from storage (erasure). */
  async deleteRecordings(
    keys: { recording_key: string; recording_version: string | null }[],
  ) {
    let pending = 0;
    for (const key of keys)
      try {
        await this.storage.delete(
          key.recording_key,
          key.recording_version ?? undefined,
        );
      } catch {
        pending++;
      }
    if (pending)
      this.logger.warn(
        `${pending} erased candidate call recording(s) couldn’t be deleted; reconcile private storage`,
      );
  }
}
