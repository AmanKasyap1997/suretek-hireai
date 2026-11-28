import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faXmark } from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { roleLabel, type Role } from './permissions';

type Automation = {
  shortlist_score: number | null;
  call_shortlisted: boolean;
  interview_score: number | null;
};
type Settings = { calling_enabled: boolean; automation?: Automation };

/** The same query as the other AI settings cards. */
const key = ['organization-integrations', 'ai-settings'];
const DEFAULT_SCORE = 70;

/** A score from 1 to 100 typed in a box, or null when it isn't one. */
const score = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
};

/** The saved automatic steps, and saving a change to some of them. */
function useAutomation() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<Settings>('/organization/ai-settings'),
    retry: false,
    // The card around it has just loaded the settings: no second request.
    staleTime: 30_000,
  });
  const saved = query.data?.automation;
  async function save(change: {
    shortlistScore?: number | null;
    callShortlisted?: boolean;
    interviewScore?: number | null;
  }) {
    // The other steps stay as saved.
    const result = await api<Settings>('/organization/ai-settings/automation', {
      method: 'PUT',
      body: JSON.stringify({
        shortlistScore: saved?.shortlist_score ?? null,
        callShortlisted: saved?.call_shortlisted ?? false,
        interviewScore: saved?.interview_score ?? null,
        ...change,
      }),
    });
    queryClient.setQueryData(key, result);
  }
  return {
    ready: !!query.data,
    saved,
    callingOn: !!query.data?.calling_enabled,
    save,
  };
}

/** Saving one block of automatic steps: busy, and what happened. */
function useSaving() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      setMessage(done);
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
  return { busy, message, error, setError, setMessage, run };
}

/**
 * In the Resume screening card: shortlist applicants at a resume score, and
 * call them. Nobody is rejected automatically.
 */
export function AutoShortlistSettings() {
  const { ready, saved, callingOn, save } = useAutomation();
  const saving = useSaving();
  const [draft, setDraft] = useState<{
    on: boolean;
    score: string;
    call: boolean;
  } | null>(null);
  if (!ready) return null;
  const value = draft ?? {
    on: saved?.shortlist_score != null,
    score: String(saved?.shortlist_score ?? DEFAULT_SCORE),
    call: !!saved?.call_shortlisted,
  };
  const change = (patch: Partial<typeof value>) => {
    setDraft({ ...value, ...patch });
    saving.setMessage('');
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const min = value.on ? score(value.score) : null;
    if (value.on && min === null) {
      saving.setError('The score is a whole number from 1 to 100.');
      return;
    }
    void saving.run(
      async () => {
        await save({
          shortlistScore: min,
          callShortlisted: value.on && value.call,
        });
        setDraft(null);
      },
      min === null
        ? 'Saved. Recruiters shortlist applicants themselves.'
        : `Saved. Applicants scoring ${min} or more are shortlisted by themselves.`,
    );
  }

  return (
    <form className="automation-form automation-block" onSubmit={submit}>
      <label className="automation-step">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => change({ on: e.target.checked })}
        />
        <span>
          Shortlist applicants whose resume scores at least{' '}
          <input
            type="number"
            min={1}
            max={100}
            aria-label="Resume score to shortlist at"
            value={value.score}
            disabled={!value.on}
            onChange={(e) => change({ score: e.target.value })}
          />
          <small>Not when a must-have requirement is missing.</small>
        </span>
      </label>
      <label className="automation-step automation-substep">
        <input
          type="checkbox"
          checked={value.on && value.call}
          disabled={!value.on}
          onChange={(e) => change({ call: e.target.checked })}
        />
        <span>
          Then call them with the AI screening call
          <small>
            {callingOn
              ? 'During calling hours, if they agreed to be called.'
              : 'Turn on AI calling first.'}
          </small>
        </span>
      </label>
      <AutomationFooter saving={saving} changed={!!draft} />
    </form>
  );
}

/**
 * In the AI calling card: move candidates to interviews at a call score, and
 * call them to book one. Nobody is rejected automatically.
 */
export function AutoInterviewSettings() {
  const { ready, saved, save } = useAutomation();
  const saving = useSaving();
  const [draft, setDraft] = useState<{ on: boolean; score: string } | null>(
    null,
  );
  if (!ready) return null;
  const value = draft ?? {
    on: saved?.interview_score != null,
    score: String(saved?.interview_score ?? DEFAULT_SCORE),
  };
  const change = (patch: Partial<typeof value>) => {
    setDraft({ ...value, ...patch });
    saving.setMessage('');
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const min = value.on ? score(value.score) : null;
    if (value.on && min === null) {
      saving.setError('The score is a whole number from 1 to 100.');
      return;
    }
    void saving.run(
      async () => {
        await save({ interviewScore: min });
        setDraft(null);
      },
      min === null
        ? 'Saved. Recruiters move candidates to interviews themselves.'
        : `Saved. Candidates whose call scores ${min} or more move to interviews by themselves.`,
    );
  }

  return (
    <form className="automation-form automation-block" onSubmit={submit}>
      <label className="automation-step">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => change({ on: e.target.checked })}
        />
        <span>
          Move candidates whose AI call scores at least{' '}
          <input
            type="number"
            min={1}
            max={100}
            aria-label="Call score to move to interviews at"
            value={value.score}
            disabled={!value.on}
            onChange={(e) => change({ score: e.target.value })}
          />{' '}
          to interviews, and call them to book one
          <small>
            The AI offers times the panel is free in your connected Google or
            Outlook calendar and sends the invitations. Set up each job’s
            Interview booking (Jobs → Interview booking). Not when a yes/no
            deal-breaker answer was wrong.
          </small>
        </span>
      </label>
      <AutomationFooter saving={saving} changed={!!draft} />
    </form>
  );
}

function AutomationFooter({
  saving,
  changed,
}: {
  saving: ReturnType<typeof useSaving>;
  changed: boolean;
}) {
  return (
    <>
      {saving.error && (
        <p role="alert" className="form-error">
          {saving.error}
        </p>
      )}
      {saving.message && (
        <p role="status" className="form-success">
          {saving.message}
        </p>
      )}
      {changed && (
        <div className="int-card-actions">
          <button
            type="submit"
            className="button-primary"
            disabled={saving.busy}
          >
            {saving.busy ? 'Saving…' : 'Save automatic steps'}
          </button>
        </div>
      )}
    </>
  );
}

export type InterviewSetup = {
  round: string;
  minutes: 30 | 45 | 60 | 90;
  mode: 'VIDEO' | 'PHONE' | 'ONSITE';
  location?: string | null;
  panelistIds: string[];
  /** 0 Sunday … 6 Saturday. */
  days: number[];
  startMinute: number;
  endMinute: number;
};
type Panelist = { id: string; full_name: string; role: string };

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const modeLabels = { VIDEO: 'Video call', PHONE: 'Phone', ONSITE: 'Onsite' };
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteOf = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/**
 * How the AI books a job's interviews: the round, its length and type, the
 * panel, and the days and hours to offer.
 */
export function InterviewBookingDialog({
  job,
  onClose,
  onSaved,
}: {
  job: { id: string; title: string; interview_setup?: InterviewSetup | null };
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const current = job.interview_setup;
  const [round, setRound] = useState(current?.round ?? 'Final round');
  const [minutes, setMinutes] = useState<InterviewSetup['minutes']>(
    current?.minutes ?? 45,
  );
  const [mode, setMode] = useState<InterviewSetup['mode']>(
    current?.mode ?? 'VIDEO',
  );
  const [location, setLocation] = useState(current?.location ?? '');
  const [panel, setPanel] = useState<string[]>(current?.panelistIds ?? []);
  const [days, setDays] = useState<number[]>(current?.days ?? [1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(clock(current?.startMinute ?? 10 * 60));
  const [to, setTo] = useState(clock(current?.endMinute ?? 17 * 60));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const people = useQuery({
    queryKey: ['interview-panelists'],
    queryFn: () => api<{ data: Panelist[] }>('/interviews/panelists'),
    retry: false,
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);

  async function send(setup: InterviewSetup | null, done: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/jobs/${job.id}/interview-setup`, {
        method: 'PUT',
        body: JSON.stringify({ interviewSetup: setup }),
      });
      onSaved(done);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Interview booking couldn’t be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const startMinute = minuteOf(from);
    const endMinute = minuteOf(to);
    if (!panel.length)
      return setError('Choose at least one person for the panel.');
    if (!days.length) return setError('Choose at least one day.');
    if (endMinute - startMinute < minutes)
      return setError('The hours must fit at least one interview.');
    void send(
      {
        round: round.trim() || 'Final round',
        minutes,
        mode,
        ...(mode === 'ONSITE' ? { location: location.trim() } : {}),
        panelistIds: panel,
        days: [...days].sort(),
        startMinute,
        endMinute,
      },
      `Interview booking is set for ${job.title}. The AI books interviews with candidates who pass their call.`,
    );
  }

  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="job-dialog cand-dialog booking-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              Interview booking
            </h2>
            <p>
              {job.title}: the AI calls candidates who pass their screening
              call, offers times the panel is free in your connected calendar,
              and books the one they pick.
            </p>
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        <form className="cand-form" onSubmit={submit}>
          <label className="form-field">
            Round
            <input
              value={round}
              maxLength={100}
              required
              onChange={(e) => setRound(e.target.value)}
            />
          </label>
          <div className="cand-form-row">
            <label className="form-field">
              Type
              <span className="select-control">
                <select
                  value={mode}
                  onChange={(e) =>
                    setMode(e.target.value as InterviewSetup['mode'])
                  }
                >
                  {(Object.keys(modeLabels) as InterviewSetup['mode'][]).map(
                    (m) => (
                      <option key={m} value={m}>
                        {modeLabels[m]}
                      </option>
                    ),
                  )}
                </select>
                <FontAwesomeIcon
                  className="select-chevron"
                  icon={faChevronDown}
                  aria-hidden="true"
                />
              </span>
            </label>
            <label className="form-field">
              Length
              <span className="select-control">
                <select
                  value={minutes}
                  onChange={(e) =>
                    setMinutes(
                      Number(e.target.value) as InterviewSetup['minutes'],
                    )
                  }
                >
                  {[30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
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
          </div>
          {mode === 'VIDEO' && (
            <p className="cand-muted booking-hint">
              Google Calendar adds a Meet link and Outlook a Teams link.
            </p>
          )}
          {mode === 'ONSITE' && (
            <label className="form-field">
              Location
              <input
                value={location}
                required
                maxLength={1000}
                placeholder="Office address and room"
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
          )}
          <fieldset className="booking-days">
            <legend>Days to offer</legend>
            {dayNames.map((name, day) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  onChange={(e) =>
                    setDays(
                      e.target.checked
                        ? [...days, day]
                        : days.filter((d) => d !== day),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </fieldset>
          <div className="cand-form-row">
            <label className="form-field">
              From
              <input
                type="time"
                value={from}
                required
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="form-field">
              To
              <input
                type="time"
                value={to}
                required
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <fieldset className="cand-panelists">
            <legend>Interview panel</legend>
            {people.isPending ? (
              <p className="cand-muted">Loading…</p>
            ) : people.isError ? (
              <p className="form-error">The team couldn’t be loaded.</p>
            ) : (
              (people.data?.data ?? []).map((person) => (
                <label key={person.id} className="cand-panelist">
                  <input
                    type="checkbox"
                    checked={panel.includes(person.id)}
                    onChange={(e) =>
                      setPanel(
                        e.target.checked
                          ? [...panel, person.id]
                          : panel.filter((p) => p !== person.id),
                      )
                    }
                  />
                  <span>
                    {person.full_name}
                    <small>{roleLabel(person.role as Role)}</small>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          <p className="cand-muted booking-hint">
            Everyone on the panel is invited, and must be free in the calendar.
            Times are in your organization’s calling time zone.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="cand-form-actions">
            {current && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void send(
                    null,
                    `Interview booking is off for ${job.title}. Recruiters book its interviews.`,
                  )
                }
              >
                Turn off
              </button>
            )}
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
