import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faPhone,
  faPhoneVolume,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { AnswerItem, outcomeLabels, type AnswerRating } from './TestCall';
import type { CallAnswer, CallOutcome } from './testCallAudio';

type CallStatus =
  'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type Attempt = {
  id: string;
  number: number;
  status:
    | 'DIALING'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'NO_ANSWER'
    | 'FAILED'
    | 'CANCELLED';
  voice_label: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: CallOutcome | null;
  answers: CallAnswer[];
  summary: string | null;
  callback_note: string | null;
  transcript:
    { speaker: 'ai' | 'candidate'; text: string; at: number }[] | null;
  has_recording: boolean;
  failure_message: string | null;
  assessment_status: 'PENDING' | 'COMPLETED' | 'FAILED' | null;
  assessment: Assessment | null;
  assessment_failure: string | null;
  /** A booking call: the times offered, and the interview booked. */
  offered_slots?: string[];
  booked_interview?: {
    starts_at: string;
    mode: string | null;
    meeting_url: string | null;
    location: string | null;
    status: string | null;
  } | null;
  created_at: string;
};
type Fit = 'STRONG' | 'GOOD' | 'PARTIAL' | 'WEAK';
type Assessment = {
  score: number | null;
  fit: Fit | null;
  deal_breaker: boolean;
  answers: {
    question_id: string;
    rating: AnswerRating | null;
    reason: string;
  }[];
  summary: string | null;
  strengths: string[];
  concerns: string[];
  provider_label: string | null;
};
const fitLabels: Record<Fit, { text: string; tone: string }> = {
  STRONG: { text: 'Strong', tone: 'success' },
  GOOD: { text: 'Good', tone: 'success' },
  PARTIAL: { text: 'Partial', tone: 'warning' },
  WEAK: { text: 'Weak', tone: 'danger' },
};
type Call = {
  id: string;
  status: CallStatus;
  outcome:
    'COMPLETED' | 'DECLINED' | 'WRONG_PERSON' | 'UNREACHED' | 'FAILED' | null;
  failure_message: string | null;
  language: 'EN' | 'HI';
  recording: boolean;
  transcription: boolean;
  question_count: number;
  attempts: number;
  max_attempts: number;
  scheduled: boolean;
  next_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
  requested_by_name: string | null;
  /** SCHEDULING: the call that books the interview. */
  purpose?: 'SCREENING' | 'SCHEDULING';
  /** Placed by HireAI itself (an automatic step). */
  automatic?: boolean;
  attempt_history: Attempt[];
};
type CallsView = {
  can_call: boolean;
  blocked: string | null;
  consents: { call: boolean; recording: boolean; transcription: boolean };
  calls: Call[];
};

const when = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const languages = { EN: 'English', HI: 'Hindi' };
const attemptLabels: Record<Attempt['status'], string> = {
  DIALING: 'Ringing',
  IN_PROGRESS: 'On the call',
  COMPLETED: 'Talked',
  NO_ANSWER: 'No answer',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};
const active = (call: Call) =>
  call.status === 'IN_PROGRESS' ||
  (call.status === 'PLANNED' && call.scheduled);
const assessing = (call: Call) =>
  call.attempt_history.some((a) => a.assessment_status === 'PENDING');

/** The AI's assessment of the answers: a suggestion for the recruiter. */
function AssessmentSummary({
  attempt,
  onReassess,
}: {
  attempt: Attempt;
  onReassess: () => void;
}) {
  if (attempt.assessment_status === 'PENDING')
    return (
      <p role="status" className="call-assessment">
        Assessing the answers…
      </p>
    );
  if (attempt.assessment_status === 'FAILED')
    return (
      <div className="call-assessment">
        <p className="call-failure">
          The answers couldn’t be assessed. {attempt.assessment_failure}
        </p>
        <button type="button" onClick={onReassess}>
          Assess again
        </button>
      </div>
    );
  const assessment = attempt.assessment;
  if (!assessment) return null;
  return (
    <div className="call-assessment">
      <p>
        <strong>AI assessment</strong>{' '}
        {assessment.fit && assessment.score !== null ? (
          <span
            className={`int-pill int-pill-${fitLabels[assessment.fit].tone}`}
          >
            {assessment.score} · {fitLabels[assessment.fit].text}
          </span>
        ) : (
          <span className="int-pill int-pill-neutral">Nothing to score</span>
        )}
        {assessment.deal_breaker && (
          <span className="int-pill int-pill-danger">Deal-breaker answer</span>
        )}
      </p>
      {assessment.summary && <p>{assessment.summary}</p>}
      {(assessment.strengths.length > 0 || assessment.concerns.length > 0) && (
        <div className="call-assessment-points">
          {assessment.strengths.length > 0 && (
            <div>
              <strong>Strengths</strong>
              <ul>
                {assessment.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {assessment.concerns.length > 0 && (
            <div>
              <strong>Concerns</strong>
              <ul>
                {assessment.concerns.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <small>
        A suggestion
        {assessment.provider_label ? ` from ${assessment.provider_label}` : ''},
        rating each answer against the question’s key points. You decide:
        shortlist, move to interview or reject below.
      </small>
    </div>
  );
}

/** Where a call stands, in one line. */
function callStatus(call: Call) {
  const tries = `attempt ${call.attempts} of ${call.max_attempts}`;
  switch (call.status) {
    case 'IN_PROGRESS':
      return { text: `Calling now (${tries})`, tone: 'info' };
    case 'PLANNED': {
      if (!call.scheduled || !call.next_attempt_at)
        return {
          text: 'Planned before calls could be placed',
          tone: 'neutral',
        };
      // The last call ended with the candidate asking to be called back.
      const last = call.attempt_history.reduce<Attempt | null>(
        (latest, a) => (!latest || a.number > latest.number ? a : latest),
        null,
      );
      return {
        text:
          new Date(call.next_attempt_at).getTime() <= Date.now()
            ? 'Calling shortly'
            : last?.outcome === 'CALL_BACK'
              ? `Calling back ${when(call.next_attempt_at)}, as the candidate asked`
              : `Calling ${when(call.next_attempt_at)}${call.attempts ? ` (${tries} done)` : ''}`,
        tone: 'info',
      };
    }
    case 'COMPLETED':
      return {
        text:
          call.outcome === 'DECLINED'
            ? 'The candidate didn’t want the call'
            : call.outcome === 'WRONG_PERSON'
              ? 'Someone else answered'
              : 'Completed',
        tone: call.outcome === 'COMPLETED' ? 'success' : 'warning',
      };
    case 'FAILED':
      return {
        text:
          call.outcome === 'UNREACHED'
            ? `Couldn’t reach the candidate after ${call.attempts} ${call.attempts === 1 ? 'try' : 'tries'}`
            : 'The call failed',
        tone: 'danger',
      };
    default:
      return { text: 'Cancelled', tone: 'neutral' };
  }
}

/** Plays a call recording, fetched only when asked for. */
function Recording({
  callId,
  attemptId,
}: {
  callId: string;
  attemptId: string;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url)
    return (
      <audio className="call-recording" controls autoPlay src={url}>
        Your browser can’t play this recording.
      </audio>
    );
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const response = await fetch(
              `/api/v1/call-requests/${callId}/attempts/${attemptId}/recording`,
              { credentials: 'same-origin', cache: 'no-store' },
            );
            if (!response.ok) throw new Error();
            setUrl(URL.createObjectURL(await response.blob()));
          } catch {
            setError('The recording couldn’t be loaded.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Loading…' : 'Play recording'}
      </button>
      {error && (
        <span role="alert" className="form-error">
          {error}
        </span>
      )}
    </>
  );
}

function CallResult({
  call,
  onCancel,
  onReassess,
}: {
  call: Call;
  onCancel: () => void;
  onReassess: (attemptId: string) => void;
}) {
  const status = callStatus(call);
  const talked = [...call.attempt_history]
    .reverse()
    .find((a) => a.status === 'COMPLETED' || a.answers.length);
  return (
    <li className="call-item">
      <div className="call-item-heading">
        <span className={`int-pill int-pill-${status.tone}`}>
          {status.text}
        </span>
        <small>
          {call.purpose === 'SCHEDULING' ? 'Interview booking call · ' : ''}
          {languages[call.language]} · asked {when(call.created_at)}
          {call.automatic
            ? ' automatically'
            : call.requested_by_name
              ? ` by ${call.requested_by_name}`
              : ''}
        </small>
        {active(call) && (
          <button type="button" onClick={onCancel}>
            {call.status === 'IN_PROGRESS' ? 'Hang up' : 'Cancel call'}
          </button>
        )}
      </div>
      {call.failure_message && (
        <p className="call-failure">{call.failure_message}</p>
      )}
      {talked && (
        <div className="call-outcome">
          <p>
            <strong>
              {talked.outcome ? outcomeLabels[talked.outcome] : 'Talked'}
            </strong>
            {talked.voice_label ? ` · ${talked.voice_label}` : ''}
            {talked.duration_seconds
              ? ` · ${Math.max(1, Math.round(talked.duration_seconds / 60))} min`
              : ''}
          </p>
          {talked.summary && <p>{talked.summary}</p>}
          {talked.booked_interview ? (
            <p className="call-booked">
              <strong>Interview booked:</strong>{' '}
              {when(talked.booked_interview.starts_at)}
              {talked.booked_interview.status === 'CANCELLED'
                ? ' (cancelled)'
                : ''}
              {talked.booked_interview.meeting_url && (
                <>
                  {' · '}
                  <a
                    href={talked.booked_interview.meeting_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Meeting link
                  </a>
                </>
              )}
              {talked.booked_interview.location
                ? ` · ${talked.booked_interview.location}`
                : ''}
            </p>
          ) : (
            call.purpose === 'SCHEDULING' &&
            !!talked.offered_slots?.length && (
              <p>
                <strong>Nothing booked.</strong> Times offered:{' '}
                {talked.offered_slots.join('; ')}.
              </p>
            )
          )}
          {talked.callback_note && (
            <p>
              <strong>Call back:</strong> {talked.callback_note}
            </p>
          )}
          <AssessmentSummary
            attempt={talked}
            onReassess={() => onReassess(talked.id)}
          />
          {talked.answers.length > 0 && (
            <ul className="call-answers">
              {talked.answers.map((answer) => (
                <AnswerItem
                  key={answer.question_id}
                  answer={answer}
                  rating={talked.assessment?.answers.find(
                    (a) => a.question_id === answer.question_id,
                  )}
                />
              ))}
            </ul>
          )}
          <p className="ai-screening-hint">
            {talked.answers.length} of {call.question_count} questions answered.
            AI answers are summaries; check anything important with the
            candidate.
          </p>
          {talked.has_recording && (
            <Recording callId={call.id} attemptId={talked.id} />
          )}
          {talked.transcript && talked.transcript.length > 0 && (
            <details className="call-transcript-details">
              <summary>Transcript</summary>
              <ol className="call-transcript">
                {talked.transcript.map((line, i) => (
                  <li key={i} data-speaker={line.speaker}>
                    <span>{line.speaker === 'ai' ? 'AI' : 'Candidate'}</span>
                    {line.text}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      {call.attempt_history.length > 0 && (
        <ol className="call-attempts" aria-label="Attempts">
          {call.attempt_history.map((attempt) => (
            <li key={attempt.id}>
              Attempt {attempt.number}: {attemptLabels[attempt.status]}
              {attempt.failure_message
                ? ` (${attempt.failure_message})`
                : ''} · {when(attempt.created_at)}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * The AI call section of an application: call the candidate, and read what
 * they said on earlier calls.
 */
export function CallPanel({ applicationId }: { applicationId: string }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const key = ['application-calls', applicationId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<CallsView>(`/applications/${applicationId}/calls`),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.calls.some((c) => active(c) || assessing(c)) ? 5000 : false,
  });
  const [language, setLanguage] = useState<'EN' | 'HI'>('EN');
  const [recording, setRecording] = useState(false);
  const [transcription, setTranscription] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const settings = useQuery({
    queryKey: ['call-questions-settings'],
    queryFn: () =>
      api<{ enabled: boolean; ai_available: boolean }>(
        '/jobs/call-questions/settings',
      ),
  });
  const view = query.data;
  // Without AI calling, show the section only for earlier calls.
  if (settings.data && !settings.data.enabled && !view?.calls.length)
    return null;

  async function call() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{ next_attempt_at: string | null }>(
        '/call-requests',
        {
          method: 'POST',
          body: JSON.stringify({
            applicationId,
            language,
            recording: recording && !!view?.consents.recording,
            transcription: transcription && !!view?.consents.transcription,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      setMessage(
        result.next_attempt_at &&
          new Date(result.next_attempt_at).getTime() > Date.now() + 60_000
          ? `Outside calling hours: the AI will call ${when(result.next_attempt_at)}.`
          : 'The AI is calling the candidate now. Answers appear here after the call.',
      );
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The call couldn’t be requested.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function reassess(callId: string, attemptId: string) {
    setError('');
    setMessage('');
    try {
      await api(`/call-requests/${callId}/attempts/${attemptId}/assessment`, {
        method: 'POST',
      });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The answers couldn’t be assessed again.',
      );
    }
  }

  async function cancel(id: string) {
    setError('');
    setMessage('');
    try {
      await api(`/call-requests/${id}/cancel`, { method: 'POST' });
      setMessage('The call was cancelled.');
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The call couldn’t be cancelled.',
      );
    }
  }

  return (
    <section
      className="application-section call-panel"
      aria-labelledby={titleId}
    >
      <h3 id={titleId}>
        <FontAwesomeIcon icon={faPhoneVolume} aria-hidden="true" /> AI call
      </h3>
      {query.isPending ? (
        <p role="status">Loading…</p>
      ) : query.isError || !view ? (
        <p role="alert" className="form-error">
          Calls couldn’t be loaded.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <>
          {view.can_call ? (
            <div className="call-form">
              <label className="form-field">
                Language
                <span className="select-control">
                  <select
                    value={language}
                    onChange={(event) =>
                      setLanguage(event.target.value as 'EN' | 'HI')
                    }
                  >
                    <option value="EN">English</option>
                    <option value="HI">Hindi</option>
                  </select>
                  <FontAwesomeIcon
                    className="select-chevron"
                    icon={faChevronDown}
                    aria-hidden="true"
                  />
                </span>
              </label>
              <label className="ai-setting-check">
                <input
                  type="checkbox"
                  checked={recording && view.consents.recording}
                  disabled={!view.consents.recording}
                  onChange={(event) => setRecording(event.target.checked)}
                />
                <span>
                  Record the call
                  {!view.consents.recording && ' (the candidate didn’t agree)'}
                </span>
              </label>
              <label className="ai-setting-check">
                <input
                  type="checkbox"
                  checked={transcription && view.consents.transcription}
                  disabled={!view.consents.transcription}
                  onChange={(event) => setTranscription(event.target.checked)}
                />
                <span>
                  Keep a transcript
                  {!view.consents.transcription &&
                    ' (the candidate didn’t agree)'}
                </span>
              </label>
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() => void call()}
              >
                <FontAwesomeIcon icon={faPhone} aria-hidden="true" />{' '}
                {busy ? 'Requesting…' : 'Call with AI'}
              </button>
            </div>
          ) : (
            view.blocked && <p className="ai-screening-hint">{view.blocked}</p>
          )}
          {message && (
            <p role="status" className="form-success">
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {view.calls.length > 0 && (
            <ul className="call-list">
              {view.calls.map((item) => (
                <CallResult
                  key={item.id}
                  call={item}
                  onCancel={() => void cancel(item.id)}
                  onReassess={(attemptId) => void reassess(item.id, attemptId)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Calls every shortlisted candidate of a job who agreed to be called. */
export function JobCallsBar({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['call-questions-settings'],
    queryFn: () =>
      api<{ enabled: boolean; ai_available: boolean }>(
        '/jobs/call-questions/settings',
      ),
  });
  const [language, setLanguage] = useState<'EN' | 'HI'>('EN');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setMessage('');
    setError('');
  }, [jobId]);
  if (!settings.data?.enabled) return null;

  async function callAll() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{
        planned: number;
        already_called: number;
        no_consent: number;
        other: number;
        problem: string | null;
      }>(`/jobs/${jobId}/calls`, {
        method: 'POST',
        body: JSON.stringify({
          language,
          recording: true,
          transcription: true,
        }),
      });
      const parts = [
        result.planned
          ? `Calling ${result.planned} shortlisted ${result.planned === 1 ? 'candidate' : 'candidates'} during calling hours.`
          : 'No new calls.',
        result.already_called ? `${result.already_called} already called.` : '',
        result.no_consent
          ? `${result.no_consent} haven’t agreed to be called.`
          : '',
      ];
      if (result.problem && !result.planned) setError(result.problem);
      setMessage(parts.filter(Boolean).join(' '));
      await queryClient.invalidateQueries({ queryKey: ['application-calls'] });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Calls couldn’t be requested.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="screening-bar call-bar">
        <FontAwesomeIcon icon={faPhoneVolume} aria-hidden="true" />
        <p>
          <strong>AI calls:</strong> call the shortlisted candidates who agreed
          to be called. Recording and transcripts only where they agreed.
        </p>
        <span className="select-control">
          <select
            aria-label="Call language"
            value={language}
            onChange={(event) => setLanguage(event.target.value as 'EN' | 'HI')}
          >
            <option value="EN">English</option>
            <option value="HI">Hindi</option>
          </select>
          <FontAwesomeIcon
            className="select-chevron"
            icon={faChevronDown}
            aria-hidden="true"
          />
        </span>
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => void callAll()}
        >
          {busy ? 'Requesting…' : 'Call shortlisted'}
        </button>
      </div>
      {message && (
        <p role="status" className="screening-bar-message">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error screening-bar-message">
          {error}
        </p>
      )}
    </>
  );
}
