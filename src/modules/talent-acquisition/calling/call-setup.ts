import { readConfig } from '../../../platform/config';
import { DbClient } from '../../../platform/database/db.service';
import {
  aiConnectionKey,
  aiSettings,
  callingOrder,
  callingStatus,
  callingVoice,
  enabledAiConnections,
} from '../../organization-integrations/organization-ai';
import { CallingPolicy, callPolicyFromEnv } from './calling.policy';
import { VoiceOption } from './call-conversation';
import { CallingHours, CallQuestion, CallSetup } from './call-script';
import { interviewSetup } from '../jobs';
import { GeminiLiveSession } from './gemini-live';
import { OpenAiRealtimeSession } from './openai-realtime';
import { VoiceError, VoiceSession } from './voice-session';

/** Why a call couldn't be placed or completed, for recruiters. */
export const callFailureMessages: Record<string, string> = {
  calling_off: 'AI calling was turned off before the call was placed.',
  not_eligible:
    'The application is no longer shortlisted or in interview, or the job is no longer published.',
  no_consent: 'The candidate’s call consent was withdrawn.',
  no_phone: 'The candidate has no valid phone number in international format.',
  no_phone_provider:
    'No phone provider is set up. An HR Admin can connect Plivo in Integrations.',
  no_voice_ai:
    'No voice AI is enabled. An HR Admin can enable Gemini or OpenAI in Integrations.',
  not_configured:
    'HireAI’s public address for phone calls isn’t set up (PUBLIC_API_BASE_URL).',
  server_off:
    'Calls are turned off on this server (CALL_PLANNING_ENABLED). Ask the deployment operator.',
  phone_auth:
    'Plivo didn’t accept the organization’s credentials. An HR Admin can reconnect Plivo.',
  dial_rejected:
    'Plivo refused the call. Check the candidate’s number and the Plivo account.',
  dial_failed: 'Plivo couldn’t be reached to place the call.',
  invalid_number: 'The phone network said the number doesn’t exist.',
  voice_unavailable:
    'The candidate answered, but the voice AI couldn’t be reached. Check the AI provider’s key and credits.',
  stream_failed: 'The call connected, but its audio link to HireAI failed.',
  no_result: 'HireAI lost track of the call before it finished.',
  unreached: 'The candidate didn’t answer or talk to the AI.',
  no_interview_setup:
    'The job has no interview booking set up (Jobs → Interview booking), so the AI couldn’t offer interview times.',
  no_calendar:
    'No calendar is connected. An HR Admin can authorize Google Calendar or Microsoft Calendar in Integrations.',
  calendar_auth:
    'The calendar connection must be authorized again in Integrations.',
  calendar_permission:
    'The calendar can’t share free/busy times. An HR Admin must authorize the calendar again in Integrations.',
  calendar_unavailable: 'The calendar couldn’t be reached. Try again later.',
  no_interview_slots:
    'The interview panel has no free time in the next two weeks within the job’s interview hours.',
};

export const callFailureMessage = (failure: string | null | undefined) =>
  failure ? (callFailureMessages[failure] ?? 'The call failed.') : null;

/** A session that fails to start, for a key that can't be decrypted. */
function unusableSession(
  provider: VoiceOption['provider'],
  model: string,
): VoiceSession {
  return {
    provider,
    model,
    start: () => Promise.reject(new VoiceError('auth', 'key unreadable')),
    sendAudio: () => undefined,
    toolResult: () => undefined,
    instruct: () => undefined,
    close: () => undefined,
  };
}

/** The organization's voice AIs, in the order to try them. */
export async function voiceOptions(
  db: DbClient,
  tenantId: string,
): Promise<VoiceOption[]> {
  const settings = await aiSettings(db, tenantId);
  const rows = callingOrder(
    await enabledAiConnections(db, tenantId),
    settings.callingProvider,
  );
  const cfg = readConfig();
  return rows.map((row) => {
    const gemini = row.provider === 'google_ai';
    const model = gemini ? cfg.GEMINI_LIVE_MODEL : cfg.OPENAI_REALTIME_MODEL;
    const voice =
      callingVoice(row.provider, settings.callingVoice) ??
      (gemini ? cfg.GEMINI_LIVE_VOICE : cfg.OPENAI_REALTIME_VOICE);
    const apiKey = aiConnectionKey(tenantId, row);
    return {
      provider: row.provider,
      model,
      create: (options, handlers) => {
        if (!apiKey) return unusableSession(row.provider, model);
        const full = { ...options, apiKey, model, voice };
        return gemini
          ? new GeminiLiveSession(full, handlers)
          : new OpenAiRealtimeSession(full, handlers);
      },
    };
  });
}

/**
 * The calling windows in force (this server's and the platform's), and
 * whether the platform has paused calls.
 */
export async function callingRules(db: DbClient) {
  const env = callPolicyFromEnv();
  const global = await db.one<{
    value: {
      emergency_pause?: boolean;
      calling_start?: number;
      calling_end?: number;
      call_quota?: number;
    };
  }>("SELECT value FROM platform_settings WHERE key='defaults'");
  const policies: CallingPolicy[] = [env];
  const value = global?.value;
  if (
    value &&
    typeof value.calling_start === 'number' &&
    typeof value.calling_end === 'number'
  )
    policies.push({
      ...env,
      startMinute: value.calling_start * 60,
      endMinute: value.calling_end * 60,
    });
  return {
    enabled: env.enabled,
    policies,
    paused: !!value?.emergency_pause,
    quota: typeof value?.call_quota === 'number' ? value.call_quota : null,
  };
}

/**
 * The hours every calling window allows (the server's and the platform's),
 * for agreeing a call-back time. null if they never overlap.
 */
export async function callingHours(db: DbClient): Promise<CallingHours | null> {
  const { policies } = await callingRules(db);
  const startMinute = Math.max(...policies.map((p) => p.startMinute));
  const endMinute = Math.min(...policies.map((p) => p.endMinute));
  return startMinute < endMinute
    ? { timezone: policies[0].timezone, startMinute, endMinute }
    : null;
}

/** Why the organization can't place phone calls now, or null. */
export async function callingProblem(db: DbClient, tenantId: string) {
  const settings = await aiSettings(db, tenantId);
  if (!settings.callingEnabled)
    return 'AI calling is off. An HR Admin can turn it on in Integrations → AI hiring tools.';
  const status = await callingStatus(
    db,
    tenantId,
    await enabledAiConnections(db, tenantId),
    settings.callingProvider,
  );
  return status.problems[0] ?? null;
}

interface SetupRow {
  organization: string;
  title: string;
  department: string | null;
  location: string | null;
  description: string | null;
  full_name: string;
  assistant_name: string | null;
  interview_setup: unknown;
}

/** The first word of a full name, for greetings. */
export function firstName(fullName: string | null | undefined) {
  return fullName?.trim().split(/\s+/)[0]?.slice(0, 60) || null;
}

/** The AI's brief for a phone call: job details and the candidate's first name. */
export async function phoneCallSetup(
  db: DbClient,
  tenantId: string,
  request: {
    application_id: string;
    language: 'EN' | 'HI';
    questions: CallQuestion[];
    /** SCHEDULING: the call that books the interview. */
    purpose?: string;
    /** The interview times offered on this attempt (a booking call). */
    slots?: { id: string; label: string }[] | null;
  },
  consent: { recording: boolean; transcription: boolean },
): Promise<CallSetup | null> {
  const row = await db.one<SetupRow>(
    `SELECT t.name AS organization,j.title,j.department,j.location,j.description,c.full_name,
       s.calling_assistant_name AS assistant_name,j.interview_setup
     FROM applications a
     JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
     JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
     JOIN tenants t ON t.id=a.tenant_id
     LEFT JOIN organization_ai_settings s ON s.tenant_id=a.tenant_id
     WHERE a.tenant_id=$1 AND a.id=$2 AND c.erased_at IS NULL`,
    [tenantId, request.application_id],
  );
  if (!row) return null;
  const setup =
    request.purpose === 'SCHEDULING'
      ? interviewSetup(row.interview_setup)
      : null;
  // A booking call without its times or the job's setup can't go ahead.
  if (request.purpose === 'SCHEDULING' && (!setup || !request.slots?.length))
    return null;
  return {
    organization: row.organization,
    assistantName: row.assistant_name,
    ...(setup && request.slots
      ? {
          booking: {
            round: setup.round,
            minutes: setup.minutes,
            mode: setup.mode,
            location: setup.location ?? null,
            slots: request.slots.map((slot) => ({
              id: slot.id,
              label: slot.label,
            })),
          },
        }
      : {}),
    job: {
      title: row.title,
      department: row.department,
      location: row.location,
      description: row.description,
    },
    candidateFirstName: firstName(row.full_name),
    language: request.language,
    questions: request.questions,
    recording: consent.recording,
    transcription: consent.transcription,
    maxSeconds: readConfig().CALL_MAX_SECONDS,
    test: false,
    callingHours: await callingHours(db),
  };
}
