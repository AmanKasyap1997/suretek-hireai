import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faCircleCheck,
  faMicrophone,
  faPhoneVolume,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { TestCallDialog } from './TestCall';
import {
  AutoInterviewSettings,
  AutoShortlistSettings,
} from './HiringAutomation';

type Provider = 'openai' | 'anthropic' | 'google_ai';
type Settings = {
  screening_provider: Provider | null;
  screening_fallback: boolean;
  providers: {
    provider: Provider;
    label: string;
    environment: 'production' | 'sandbox';
  }[];
  problem: string | null;
  calling_enabled?: boolean;
  calling_provider?: 'openai' | 'google_ai' | null;
  calling_voice?: string | null;
  /** The name the AI introduces itself with on calls. */
  calling_assistant_name?: string | null;
  calling?: {
    voice_providers: { provider: 'openai' | 'google_ai'; label: string }[];
    voice: {
      provider: 'openai' | 'google_ai';
      label: string;
      /** The chosen voice; null: the server's default. */
      name?: string | null;
      voices?: { id: string; label: string }[];
    } | null;
    phone: {
      provider: 'plivo';
      environment: 'production' | 'sandbox';
      number: string | null;
    } | null;
    voice_problem: string | null;
    problems: string[];
  };
};
const labels: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google_ai: 'Google AI Studio',
};
const key = ['organization-integrations', 'ai-settings'];

/** The HR Admin's choice of which AI screens candidates' resumes. */
export function AiScreeningSettings() {
  const id = useId();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<Settings>('/organization/ai-settings'),
    retry: false,
  });
  // Unsaved edits; the saved choice otherwise.
  const [draft, setDraft] = useState<{
    provider: Provider | '';
    fallback: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const data = query.data;
  const saved = {
    provider: (data?.screening_provider ?? '') as Provider | '',
    fallback: data?.screening_fallback ?? true,
  };
  const value = draft ?? saved;
  const changed =
    !!draft &&
    (draft.provider !== saved.provider ||
      (!!draft.provider && draft.fallback !== saved.fallback));
  const enabled = data?.providers ?? [];
  const chosenMissing =
    !!value.provider && !enabled.some((p) => p.provider === value.provider);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<Settings>('/organization/ai-settings', {
        method: 'PUT',
        body: JSON.stringify({
          screeningProvider: value.provider || null,
          screeningFallback: value.provider ? value.fallback : true,
        }),
      });
      queryClient.setQueryData(key, result);
      setDraft(null);
      setMessage(
        value.provider
          ? `Saved. ${labels[value.provider]} now screens resumes${value.fallback ? ', with the other enabled providers as backup' : ''}.`
          : 'Saved. Resumes are screened by the enabled providers in order.',
      );
      // Job screening bars and the drafting picker follow the new choice.
      await queryClient.invalidateQueries({ queryKey: ['job-screening'] });
      await queryClient.invalidateQueries({ queryKey: ['job-ai-providers'] });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The setting couldn’t be saved. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const pill = !data
    ? null
    : data.problem
      ? { text: 'Needs attention', tone: 'danger' }
      : data.screening_provider
        ? {
            text: `${labels[data.screening_provider]}${data.screening_fallback ? ' + backup' : ' only'}`,
            tone: 'success',
          }
        : enabled.length
          ? { text: 'Automatic', tone: 'neutral' }
          : { text: 'Not available', tone: 'neutral' };
  return (
    <section className="int-card ai-setting-card" aria-labelledby={id}>
      <header className="int-card-header">
        <span className="icon-tile" aria-hidden="true">
          <FontAwesomeIcon icon={faWandMagicSparkles} />
        </span>
        <div>
          <div className="int-card-title">
            <h4 id={id}>Resume screening</h4>
            {pill && (
              <span className={`int-pill int-pill-${pill.tone}`}>
                {pill.text}
              </span>
            )}
          </div>
          <p>
            Which AI reads candidates’ resumes and rates them against each job’s
            criteria. Resumes go only to the provider chosen here.
          </p>
        </div>
      </header>
      {query.isPending ? (
        <p role="status">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="form-error">
          The resume screening setting couldn’t be loaded.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : !enabled.length ? (
        <p className="ai-screening-hint">
          Connect, test and enable an AI provider above to screen resumes.
        </p>
      ) : (
        <form
          className="ai-screening-form"
          onSubmit={(event) => void save(event)}
        >
          {data?.problem && !draft && (
            <p role="alert" className="form-error">
              {data.problem}
            </p>
          )}
          <label className="form-field">
            Screen resumes with
            <span className="select-control">
              <select
                value={value.provider}
                onChange={(event) => {
                  const provider = event.target.value as Provider | '';
                  setMessage('');
                  setError('');
                  setDraft({
                    provider,
                    // A chosen provider screens alone unless the admin opts
                    // in, so every candidate is scored by the same AI.
                    fallback:
                      provider && provider === saved.provider
                        ? saved.fallback
                        : !provider,
                  });
                }}
              >
                <option value="">
                  Automatic:{' '}
                  {enabled.map((p) => labels[p.provider]).join(', then ')}
                </option>
                {enabled.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {labels[p.provider]}
                    {p.environment === 'sandbox' ? ' (sandbox)' : ''}
                  </option>
                ))}
                {chosenMissing && (
                  <option value={value.provider}>
                    {labels[value.provider as Provider]} (not enabled)
                  </option>
                )}
              </select>
              <FontAwesomeIcon
                className="select-chevron"
                icon={faChevronDown}
                aria-hidden="true"
              />
            </span>
          </label>
          {value.provider ? (
            <div className="ai-screening-fallback">
              <label className="ai-setting-check">
                <input
                  type="checkbox"
                  checked={value.fallback}
                  onChange={(event) => {
                    setMessage('');
                    setDraft({ ...value, fallback: event.target.checked });
                  }}
                />
                <span>
                  If {labels[value.provider]} can’t be used, screen with another
                  enabled provider
                </span>
              </label>
              <p className="ai-screening-hint">
                {value.fallback
                  ? 'Screening keeps going when a provider runs out of credits or is down, but candidates for one job may be scored by different AI models.'
                  : `Every candidate is scored by ${labels[value.provider]}. If it can’t be used, for example when it runs out of credits, screenings show why and recruiters can screen again once it’s fixed.`}
              </p>
            </div>
          ) : (
            <p className="ai-screening-hint">
              HireAI tries each enabled provider in this order. If one can’t be
              used, for example when it runs out of credits, the next one
              screens the resume.
            </p>
          )}
          <div className="int-card-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={!changed || busy}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {changed && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {message && (
            <p role="status" className="form-success ai-screening-message">
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error ai-screening-message">
              {error}
            </p>
          )}
        </form>
      )}
      {!!data && enabled.length > 0 && <AutoShortlistSettings />}
    </section>
  );
}

type CallingProvider = 'openai' | 'google_ai';
const callingLabels: Record<CallingProvider, string> = {
  openai: 'OpenAI Realtime',
  google_ai: 'Gemini Live',
};

/**
 * The HR Admin's AI calling switch and voice AI. Shows what calls still need
 * (Plivo, a voice AI, server setup) and lets them try a call from the browser.
 */
export function AiCallingSettings() {
  const id = useId();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<Settings>('/organization/ai-settings'),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  /** The name being typed; null: the saved one. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const data = query.data;
  const enabled = !!data?.calling_enabled;
  const calling = data?.calling;
  const savedName = data?.calling_assistant_name ?? '';
  const name = nameDraft ?? savedName;

  async function save(
    next: boolean,
    change: {
      provider?: CallingProvider | null;
      voice?: string | null;
      assistantName?: string | null;
    } = {},
  ) {
    const { provider, voice, assistantName } = change;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<Settings>('/organization/ai-settings/calling', {
        method: 'PUT',
        // Only what changed; the rest stays as saved.
        body: JSON.stringify({ enabled: next, ...change }),
      });
      queryClient.setQueryData(key, result);
      if (assistantName !== undefined) setNameDraft(null);
      await queryClient.invalidateQueries({
        queryKey: ['call-questions-settings'],
      });
      setMessage(
        assistantName !== undefined
          ? assistantName
            ? `Saved. The AI introduces itself as ${assistantName}. Try a test call to hear it.`
            : 'Saved. The AI introduces itself by your organization’s name.'
          : voice !== undefined
            ? `Saved. Calls use ${
                voice
                  ? (result.calling?.voice?.voices?.find((v) => v.id === voice)
                      ?.label ?? voice)
                  : 'the default voice'
              }. Try a test call to hear it.`
            : provider !== undefined
              ? provider
                ? `Saved. ${callingLabels[provider]} talks to candidates.`
                : 'Saved. Calls use the enabled voice AIs in order.'
              : next
                ? 'AI calling is on. Recruiters can call shortlisted candidates and prepare each job’s questions.'
                : 'AI calling is off. Calls waiting to be placed won’t be dialed; jobs keep their questions.',
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The setting couldn’t be saved. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = enabled && !!calling && !calling.problems.length;
  const pill = !data
    ? null
    : !enabled
      ? { text: 'Off', tone: 'neutral' }
      : ready
        ? { text: 'Ready to call', tone: 'success' }
        : { text: 'Setup needed', tone: 'warning' };
  return (
    <section className="int-card ai-setting-card" aria-labelledby={id}>
      <header className="int-card-header">
        <span className="icon-tile" aria-hidden="true">
          <FontAwesomeIcon icon={faPhoneVolume} />
        </span>
        <div>
          <div className="int-card-title">
            <h4 id={id}>AI calling</h4>
            {pill && (
              <span className={`int-pill int-pill-${pill.tone}`}>
                {pill.text}
              </span>
            )}
            {data && (
              <label className="int-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => void save(event.target.checked)}
                />
                <span className="int-switch-track" aria-hidden="true" />
                <span className="sr-only">
                  Turn on AI calling and job call questions
                </span>
              </label>
            )}
          </div>
          <p>
            An AI voice assistant phones shortlisted candidates who agreed to be
            called and asks each job’s questions.
          </p>
        </div>
      </header>
      {query.isPending ? (
        <p role="status">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="form-error">
          The AI calling setting couldn’t be loaded.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <ul className="ai-checklist">
            {[
              'Calls shortlisted candidates who haven’t opted out, during calling hours',
              'Confirms it’s talking to the candidate, says it’s an AI, and records or transcribes only with consent',
              'Recruiters get the answers; nobody is rejected automatically',
            ].map((point) => (
              <li key={point}>
                <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
          {enabled && calling && (
            <>
              {calling.voice_providers.length > 0 && (
                <label className="form-field">
                  Voice AI
                  <span className="select-control">
                    <select
                      value={data?.calling_provider ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        void save(true, {
                          provider: (event.target.value ||
                            null) as CallingProvider | null,
                        })
                      }
                    >
                      <option value="">
                        Automatic:{' '}
                        {calling.voice_providers
                          .map((p) => p.label)
                          .join(', then ')}
                      </option>
                      {calling.voice_providers.map((p) => (
                        <option key={p.provider} value={p.provider}>
                          {p.label}
                        </option>
                      ))}
                      {data?.calling_provider &&
                        !calling.voice_providers.some(
                          (p) => p.provider === data.calling_provider,
                        ) && (
                          <option value={data.calling_provider}>
                            {callingLabels[data.calling_provider]} (not enabled)
                          </option>
                        )}
                    </select>
                    <FontAwesomeIcon
                      className="select-chevron"
                      icon={faChevronDown}
                      aria-hidden="true"
                    />
                  </span>
                </label>
              )}
              {(calling.voice?.voices?.length ?? 0) > 0 && (
                <label className="form-field">
                  Voice
                  <span className="select-control">
                    <select
                      value={calling.voice?.name ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        void save(true, {
                          voice: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Default</option>
                      {calling.voice!.voices!.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
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
              <form
                className="assistant-name-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(true, { assistantName: name.trim() || null });
                }}
              >
                <label className="form-field">
                  Assistant name
                  <input
                    value={name}
                    maxLength={40}
                    placeholder="For example, Priya"
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || name.trim() === savedName}
                >
                  Save name
                </button>
                <p className="ai-screening-hint">
                  The AI greets candidates with it (“Hi, this is{' '}
                  {name.trim() || 'Priya'} from … Am I speaking with Asha?”). It
                  talks about the application only once they confirm, and still
                  says it’s an AI assistant.
                </p>
              </form>
              <dl className="call-setup">
                <div>
                  <dt>Phone</dt>
                  <dd>
                    {calling.phone
                      ? `Plivo · ${calling.phone.number ?? 'reconnect needed'}${
                          calling.phone.environment === 'sandbox'
                            ? ' (sandbox)'
                            : ''
                        }`
                      : 'Not connected'}
                  </dd>
                </div>
                <div>
                  <dt>Voice</dt>
                  <dd>{calling.voice?.label ?? 'Not available'}</dd>
                </div>
              </dl>
              {calling.problems.length > 0 && (
                <ul
                  className="call-problems"
                  aria-label="Before calls can be placed"
                >
                  {calling.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              <p className="ai-screening-hint">
                Recruiters start calls from a shortlisted application or a job’s
                applications. HireAI calls during calling hours and tries up to
                three times.
              </p>
              <div className="int-card-actions">
                <button
                  type="button"
                  disabled={!calling.voice}
                  onClick={() => setTesting(true)}
                >
                  <FontAwesomeIcon icon={faMicrophone} aria-hidden="true" /> Try
                  a test call
                </button>
              </div>
              <AutoInterviewSettings />
            </>
          )}
        </>
      )}
      {message && (
        <p role="status" className="form-success ai-screening-message">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error ai-screening-message">
          {error}
        </p>
      )}
      {testing && <TestCallDialog onClose={() => setTesting(false)} />}
    </section>
  );
}
