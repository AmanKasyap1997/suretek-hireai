import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faCircleCheck,
  faPhoneVolume,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';

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
    </section>
  );
}

/**
 * The HR Admin's AI calling switch. Calls aren't placed yet; while it's on,
 * recruiters prepare the questions each job's AI call will ask.
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
  const enabled = !!query.data?.calling_enabled;

  async function change(next: boolean) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<Settings>('/organization/ai-settings/calling', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      queryClient.setQueryData(key, result);
      await queryClient.invalidateQueries({
        queryKey: ['call-questions-settings'],
      });
      setMessage(
        next
          ? 'AI calling is on. Recruiters now see call questions on each job.'
          : 'AI calling is off. Jobs keep their questions for later.',
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

  return (
    <section className="int-card ai-setting-card" aria-labelledby={id}>
      <header className="int-card-header">
        <span className="icon-tile" aria-hidden="true">
          <FontAwesomeIcon icon={faPhoneVolume} />
        </span>
        <div>
          <div className="int-card-title">
            <h4 id={id}>AI calling</h4>
            {query.data && (
              <label className="int-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => void change(event.target.checked)}
                />
                <span className="int-switch-track" aria-hidden="true" />
                <span className="sr-only">
                  Turn on AI calling and job call questions
                </span>
              </label>
            )}
          </div>
          <p>
            An AI voice assistant calls candidates who agreed to be called and
            asks each job’s questions.
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
        <ul className="ai-checklist">
          {[
            'Calls only candidates whose call consent was verified by email',
            'Asks each job’s questions, prepared in the job form',
            'Recruiters get the answers; nobody is rejected automatically',
          ].map((point) => (
            <li key={point}>
              <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
              {point}
            </li>
          ))}
        </ul>
      )}
      <p className="ai-screening-hint">
        Calls aren’t placed yet. While this is on, recruiters prepare the call
        questions on each job.
      </p>
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
    </section>
  );
}
