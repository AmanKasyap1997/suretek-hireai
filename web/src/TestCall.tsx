import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faMicrophone,
  faPhoneSlash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { ApiError, api } from './api';
import {
  startTestCall,
  type CallAnswer,
  type CallOutcome,
  type TestCallConnection,
} from './testCallAudio';

type Question = {
  id: string;
  text: string;
  answer_type: 'yes_no' | 'number' | 'text';
  expected_answer: 'yes' | 'no' | null;
  criterion_id: string | null;
  key_points?: string[];
};
type Job = { id: string; title: string; call_questions?: Question[] | null };
type Line = { speaker: 'ai' | 'candidate'; text: string };

export const outcomeLabels: Record<CallOutcome, string> = {
  COMPLETED: 'Questions answered',
  DECLINED: 'Didn’t want the call',
  CALL_BACK: 'Asked to be called back',
  WRONG_PERSON: 'Someone else answered',
  NO_RESPONSE: 'No answers',
};
const providerLabels: Record<string, string> = {
  google_ai: 'Gemini Live',
  openai: 'OpenAI Realtime',
};

export type AnswerRating = 'STRONG' | 'GOOD' | 'PARTIAL' | 'WEAK' | 'NO_ANSWER';
export const ratingLabels: Record<
  AnswerRating,
  { text: string; tone: string }
> = {
  STRONG: { text: 'Strong answer', tone: 'success' },
  GOOD: { text: 'Good answer', tone: 'success' },
  PARTIAL: { text: 'Partial answer', tone: 'warning' },
  WEAK: { text: 'Weak answer', tone: 'danger' },
  NO_ANSWER: { text: 'No answer', tone: 'neutral' },
};

/**
 * One answer the AI recorded, with how it compares to the expected one and,
 * after the call, how the assessment rated it.
 */
export function AnswerItem({
  answer,
  rating,
}: {
  answer: CallAnswer;
  rating?: { rating: AnswerRating | null; reason: string };
}) {
  return (
    <li className="call-answer">
      <strong>{answer.question}</strong>
      <span>
        {answer.answered
          ? answer.answer || answer.value || 'Answered'
          : `Not answered${answer.answer ? ` — ${answer.answer}` : ''}`}
      </span>
      {answer.matches_expected === false && (
        <span className="int-pill int-pill-warning">
          Expected “{answer.expected_answer}”
        </span>
      )}
      {answer.matches_expected === true && (
        <span className="int-pill int-pill-success">As expected</span>
      )}
      {rating?.rating && answer.matches_expected === null && (
        <span className="call-answer-rating">
          <span
            className={`int-pill int-pill-${ratingLabels[rating.rating].tone}`}
          >
            {ratingLabels[rating.rating].text}
          </span>{' '}
          {rating.reason}
        </span>
      )}
    </li>
  );
}

/**
 * Try an AI call from the browser: the recruiter answers as a candidate would.
 * Nothing about a test call is saved.
 */
export function TestCallDialog({
  jobId: fixedJobId,
  questions,
  onClose,
}: {
  /** Test this job; otherwise the recruiter picks one. */
  jobId?: string;
  /** Unsaved questions from the job form. */
  questions?: Question[];
  onClose: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const connection = useRef<TestCallConnection | null>(null);
  const jobs = useQuery({
    queryKey: ['test-call-jobs'],
    queryFn: () =>
      api<{ data: Job[] }>('/jobs?limit=100&sort=updated_at&direction=desc'),
    enabled: !fixedJobId,
  });
  const choices = (jobs.data?.data ?? []).filter(
    (job) => (job.call_questions ?? []).length > 0,
  );
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [language, setLanguage] = useState<'EN' | 'HI'>('EN');
  const [phase, setPhase] = useState<'setup' | 'connecting' | 'live' | 'ended'>(
    'setup',
  );
  const [voice, setVoice] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [answers, setAnswers] = useState<CallAnswer[]>([]);
  const [ending, setEnding] = useState<{
    outcome: CallOutcome;
    summary: string | null;
    reason: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const chosen = jobId || choices[0]?.id || '';

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => {
      connection.current?.hangUp();
      opener?.focus();
    };
  }, []);
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  async function start() {
    setError('');
    setLines([]);
    setAnswers([]);
    setEnding(null);
    setSeconds(0);
    setPhase('connecting');
    try {
      const session = await api<{ ticket: string; voice: string | null }>(
        '/calls/test-sessions',
        {
          method: 'POST',
          body: JSON.stringify({
            jobId: chosen,
            language,
            ...(questions ? { questions } : {}),
          }),
        },
      );
      setVoice(session.voice ?? '');
      connection.current = await startTestCall(session.ticket, {
        live: (provider) => {
          setVoice(providerLabels[provider] ?? provider);
          setPhase('live');
        },
        transcript: (speaker, text) =>
          setLines((current) => [...current, { speaker, text }]),
        answer: (answer) =>
          setAnswers((current) => [
            ...current.filter((a) => a.question_id !== answer.question_id),
            answer,
          ]),
        ended: (outcome, summary, reason) =>
          setEnding({ outcome, summary, reason }),
        closed: () => {
          connection.current = null;
          setPhase('ended');
        },
      });
    } catch (reason) {
      connection.current = null;
      setPhase('setup');
      setError(
        reason instanceof ApiError
          ? reason.message
          : reason instanceof DOMException && reason.name === 'NotAllowedError'
            ? 'Allow microphone access in your browser to try a call.'
            : 'The test call couldn’t start. Check your microphone and try again.',
      );
    }
  }

  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="job-dialog test-call-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              Try an AI call
            </h2>
            <p>
              Answer as a candidate would. The AI asks the job’s questions;
              nothing about a test call is saved.
            </p>
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Close test call"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        {phase === 'setup' && (
          <div className="test-call-setup">
            {!fixedJobId && (
              <label className="form-field">
                Job
                <span className="select-control">
                  <select
                    value={chosen}
                    disabled={!choices.length}
                    onChange={(event) => setJobId(event.target.value)}
                  >
                    {!choices.length && (
                      <option value="">
                        {jobs.isPending
                          ? 'Loading jobs…'
                          : 'No job has call questions yet'}
                      </option>
                    )}
                    {choices.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.title} ({job.call_questions!.length}{' '}
                        {job.call_questions!.length === 1
                          ? 'question'
                          : 'questions'}
                        )
                      </option>
                    ))}
                  </select>
                  <FontAwesomeIcon
                    className="select-chevron"
                    icon={faChevronDown}
                    aria-hidden="true"
                  />
                </span>
              </label>
            )}
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
            <p className="ai-screening-hint">
              Your browser asks for the microphone. Use headphones if you can.
              Your voice goes to the organization’s voice AI for this call only.
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="int-card-actions">
              <button
                type="button"
                className="button-primary"
                disabled={!chosen}
                onClick={() => void start()}
              >
                <FontAwesomeIcon icon={faMicrophone} aria-hidden="true" /> Start
                test call
              </button>
            </div>
          </div>
        )}
        {phase !== 'setup' && (
          <div className="test-call-live">
            <p role="status" className="test-call-status">
              {phase === 'connecting'
                ? 'Connecting to the voice AI…'
                : phase === 'live'
                  ? `On the call with ${voice || 'the AI'} · ${minutes}`
                  : 'The call ended.'}
            </p>
            {ending && (
              <div className="test-call-ending">
                <strong>{outcomeLabels[ending.outcome]}</strong>
                {ending.summary && <p>{ending.summary}</p>}
              </div>
            )}
            <div className="test-call-columns">
              <section aria-label="Conversation">
                <h3>Conversation</h3>
                {lines.length ? (
                  <ol className="call-transcript">
                    {lines.map((line, i) => (
                      <li key={i} data-speaker={line.speaker}>
                        <span>{line.speaker === 'ai' ? 'AI' : 'You'}</span>
                        {line.text}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="ai-screening-hint">
                    What you and the AI say appears here.
                  </p>
                )}
              </section>
              <section aria-label="Answers recorded">
                <h3>Answers recorded</h3>
                {answers.length ? (
                  <ul className="call-answers">
                    {answers.map((answer) => (
                      <AnswerItem key={answer.question_id} answer={answer} />
                    ))}
                  </ul>
                ) : (
                  <p className="ai-screening-hint">None yet.</p>
                )}
              </section>
            </div>
            <div className="int-card-actions">
              {phase === 'ended' ? (
                <>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => setPhase('setup')}
                  >
                    Try again
                  </button>
                  <button type="button" onClick={onClose}>
                    Close
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button-danger"
                  onClick={() => {
                    connection.current?.hangUp();
                    connection.current = null;
                    setPhase('ended');
                  }}
                >
                  <FontAwesomeIcon icon={faPhoneSlash} aria-hidden="true" />{' '}
                  Hang up
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
