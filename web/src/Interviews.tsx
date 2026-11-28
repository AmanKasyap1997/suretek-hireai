import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBuilding,
  faCalendarCheck,
  faCalendarDays,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faList,
  faPhone,
  faTriangleExclamation,
  faUsers,
  faVideo,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { useAuth } from './auth';
import { roleLabel, type Role } from './permissions';

export type InterviewMode = 'VIDEO' | 'PHONE' | 'ONSITE';
export type CalendarProvider = 'google_calendar' | 'microsoft_calendar';
type Criterion = { id: string; label: string };
export type Interview = {
  id: string;
  application_id: string;
  job_id: string;
  job_title: string;
  /** Null once the candidate's personal data is erased. */
  candidate_name: string | null;
  application_stage: string;
  round: string;
  mode: InterviewMode;
  starts_at: string;
  ends_at: string;
  location: string | null;
  meeting_url: string | null;
  status: 'SCHEDULED' | 'CANCELLED';
  criteria_snapshot: Criterion[];
  panelist_ids: string[];
  panel: { id: string; full_name: string; role: string }[];
  /** Null for panelists who see only their own feedback. */
  scorecard_count: number | null;
  my_scorecard: boolean;
  on_calendar: boolean;
  calendar_provider: CalendarProvider | null;
  /** Null when the AI booked it on a call with the candidate. */
  created_by: string | null;
  created_by_name: string | null;
};
type CalendarProblem = 'auth' | 'permission' | 'unavailable' | 'missing';
type CalendarSync = {
  status:
    'added' | 'updated' | 'moved' | 'not_sent' | 'not_connected' | 'failed';
  provider?: CalendarProvider;
  problem?: CalendarProblem;
  /** The calendar account the invitations come from. */
  organizer?: string | null;
  /** The candidate's address it invited, and how many panelists. */
  candidate?: string | null;
  panel?: number;
  warnings?: ('candidate_is_organizer' | 'no_meeting_link')[];
};
type CalendarStatus = {
  /** Where interviews go (an HR Admin's choice when both are connected). */
  provider: CalendarProvider | null;
  connected: CalendarProvider[];
};
type Saved = Interview & { calendar: CalendarSync };
type Recommendation =
  'STRONG_HIRE' | 'HIRE' | 'HOLD' | 'NO_HIRE' | 'STRONG_NO_HIRE';
type Scorecard = {
  id: string;
  panelist_user_id: string;
  scores: { criterionId: string; score: number }[];
  recommendation: Recommendation;
  notes: string;
  submitted_at: string;
};
type Page = { data: Interview[]; total: number };
type Panelist = { id: string; full_name: string; role: string };
/** The application an interview is for. */
export type InterviewFor = {
  id: string;
  candidateName: string;
  jobTitle: string;
  stage: string;
};

export const modeLabels: Record<InterviewMode, string> = {
  VIDEO: 'Video call',
  PHONE: 'Phone',
  ONSITE: 'Onsite',
};
const modeIcons = { VIDEO: faVideo, PHONE: faPhone, ONSITE: faBuilding };
export const calendarNames: Record<CalendarProvider, string> = {
  google_calendar: 'Google Calendar',
  microsoft_calendar: 'Microsoft Calendar',
};
const meetingNames: Record<CalendarProvider, string> = {
  google_calendar: 'Google Meet',
  microsoft_calendar: 'Microsoft Teams',
};
const recommendationLabels: Record<Recommendation, string> = {
  STRONG_HIRE: 'Strong hire',
  HIRE: 'Hire',
  HOLD: 'Hold',
  NO_HIRE: 'No hire',
  STRONG_NO_HIRE: 'Strong no hire',
};
const scoreLabels = [
  'No evidence',
  'Poor',
  'Weak',
  'Fair',
  'Good',
  'Excellent',
];
const phaseLabels = {
  upcoming: 'Upcoming',
  live: 'In progress',
  done: 'Completed',
  cancelled: 'Cancelled',
};
const MANAGERS = ['HR_ADMIN', 'RECRUITER'];

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const minutesBetween = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 60000);
/** "Wed, Mar 4, 2026 · 10:00 AM – 10:45 AM". */
export const whenLabel = (
  interview: Pick<Interview, 'starts_at' | 'ends_at'>,
) =>
  `${dayFormat.format(new Date(interview.starts_at))} · ${timeFormat.format(
    new Date(interview.starts_at),
  )} – ${timeFormat.format(new Date(interview.ends_at))}`;
/** YYYY-MM-DD in the viewer's time zone. */
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const candidateOf = (interview: Interview) =>
  interview.candidate_name ?? 'Erased candidate';

export function phase(interview: Interview, now = Date.now()) {
  if (interview.status === 'CANCELLED') return 'cancelled' as const;
  if (Date.parse(interview.ends_at) <= now) return 'done' as const;
  if (Date.parse(interview.starts_at) <= now) return 'live' as const;
  return 'upcoming' as const;
}

function problemText(problem: CalendarProblem | undefined, name: string) {
  switch (problem) {
    case 'auth':
      return `${name} needs to be connected again in Integrations.`;
    case 'permission':
      return `${name} didn’t allow HireAI to add events. Connect it again in Integrations.`;
    case 'missing':
      return 'its event couldn’t be found.';
    default:
      return `${name} couldn’t be reached. Try again shortly.`;
  }
}

/**
 * What to tell the recruiter after saving: a notice, with who the calendar
 * invited and from which account, and anything that stops an email arriving.
 */
function savedMessage(saved: Saved, done: string): [string, string] {
  const sync: CalendarSync = saved.calendar ?? { status: 'not_sent' };
  const name = sync.provider ? calendarNames[sync.provider] : 'the calendar';
  if (sync.status === 'failed')
    return [
      done,
      `It isn’t in ${name}: ${problemText(sync.problem, name)} Then choose Add to calendar on the interview.`,
    ];
  if (
    sync.status !== 'added' &&
    sync.status !== 'updated' &&
    sync.status !== 'moved'
  )
    return [done, ''];
  const from = sync.organizer ? ` from ${sync.organizer}` : '';
  const who = [
    sync.candidate ?? 'the candidate',
    ...(sync.panel ? [plural(sync.panel, 'panel member')] : []),
  ].join(' and ');
  const notice =
    sync.status === 'updated'
      ? `${done} ${name} sent the change${from} to ${who}.`
      : sync.status === 'moved'
        ? `${done} Moved to ${name}: the old event was cancelled, and ${name} sent new invitations${from} to ${who}.`
        : `${done} ${name} sent invitations${from} to ${who}.`;
  const warnings = (sync.warnings ?? []).map((warning) =>
    warning === 'candidate_is_organizer'
      ? `${sync.candidate ?? 'The candidate’s address'} is ${name}’s own account, so the event is in that calendar but no invitation email was sent to it. Use a different address for the candidate, or connect a shared recruiting calendar.`
      : `${name} couldn’t create a meeting link for this account. Reschedule the interview to add your own link.`,
  );
  return [notice, warnings.join(' ')];
}

export function useCanManageInterviews() {
  const user = useAuth().session?.user;
  return (
    !!user &&
    [user.role, ...(user.roles ?? [])].some((role) => MANAGERS.includes(role))
  );
}

/** Where interviews go, and the connected calendars (recruiters only). */
function useCalendarStatus(enabled: boolean, version = '') {
  return useQuery({
    queryKey: ['interviews', 'calendar', version],
    queryFn: () => api<CalendarStatus>('/interviews/calendar'),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * For HR Admins in Integrations: which connected calendar interviews go in.
 * `version` changes when a calendar connection does.
 */
export function InterviewCalendarSetting({ version }: { version: string }) {
  const queryClient = useQueryClient();
  const status = useCalendarStatus(true, version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const connected = status.data?.connected ?? [];
  if (!connected.length) return null;
  async function choose(provider: CalendarProvider) {
    setSaving(true);
    setError('');
    try {
      await api('/interviews/calendar', {
        method: 'PUT',
        body: JSON.stringify({ provider }),
      });
      await queryClient.invalidateQueries({
        queryKey: ['interviews', 'calendar'],
      });
    } catch (failure) {
      setError(message(failure, 'The calendar couldn’t be changed.'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="iv-calendar-setting">
      {connected.length === 1 ? (
        <p>
          <FontAwesomeIcon icon={faCalendarCheck} aria-hidden="true" />{' '}
          Interviews go in {calendarNames[connected[0]]}, which invites the
          panel and the candidate.
        </p>
      ) : (
        <fieldset disabled={saving}>
          <legend>Interviews go in</legend>
          {connected.map((provider) => (
            <label key={provider}>
              <input
                type="radio"
                name="interview-calendar"
                checked={status.data?.provider === provider}
                onChange={() => void choose(provider)}
              />
              {calendarNames[provider]}
            </label>
          ))}
          <small>
            It sends the invitations to the panel and the candidate. The AI
            books interviews in it too. Recruiters can pick the other one when
            scheduling.
          </small>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Everything that shows interviews, after one changed. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['interviews'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      queryClient.invalidateQueries({ queryKey: ['applications'] }),
    ]);
}

function Modal({
  title,
  subtitle,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Opened over another dialog: close only this one.
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`job-dialog cand-dialog${wide ? ' iv-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              {title}
            </h2>
            {subtitle && <p>{subtitle}</p>}
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
        {children}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="form-field">
      {label}
      <span className="select-control">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map(([key, text]) => (
            <option key={key} value={key}>
              {text}
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
  );
}

function PhaseChip({ interview }: { interview: Interview }) {
  const current = phase(interview);
  return (
    <span className={`iv-chip iv-chip-${current}`}>{phaseLabels[current]}</span>
  );
}

function CalendarChip({ interview }: { interview: Interview }) {
  if (interview.status === 'CANCELLED') return null;
  return interview.on_calendar && interview.calendar_provider ? (
    <span className="iv-chip iv-chip-calendar">
      <FontAwesomeIcon icon={faCalendarCheck} aria-hidden="true" /> In{' '}
      {calendarNames[interview.calendar_provider]}
    </span>
  ) : (
    <span className="iv-chip iv-chip-muted">Not in a calendar</span>
  );
}

/** How much feedback there is, as the viewer may see it. */
function feedbackLabel(interview: Interview) {
  if (interview.status === 'CANCELLED') return '—';
  if (interview.scorecard_count === null)
    return interview.my_scorecard
      ? 'Feedback given'
      : phase(interview) === 'upcoming'
        ? '—'
        : 'Your feedback is due';
  return `${interview.scorecard_count} of ${interview.panel.length}`;
}

/** Tomorrow, as YYYY-MM-DD in the recruiter's time zone. */
function tomorrow() {
  return dayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
}
const clock = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/**
 * Schedules an interview for an application, or reschedules one. With a
 * connected calendar it's added there, which invites the panel and the
 * candidate, and can create the video meeting.
 */
export function InterviewForm({
  application,
  interview,
  onClose,
  onSaved,
}: {
  application: InterviewFor;
  /** Given: reschedule it. */
  interview?: Interview;
  onClose: () => void;
  onSaved: (notice: string, problem: string) => Promise<void> | void;
}) {
  const userId = useAuth().session?.user.id;
  const start = interview ? new Date(interview.starts_at) : null;
  const length = interview
    ? String(minutesBetween(interview.starts_at, interview.ends_at))
    : '45';
  const [round, setRound] = useState(interview?.round ?? 'Round 1');
  const [mode, setMode] = useState<InterviewMode>(interview?.mode ?? 'VIDEO');
  const [day, setDay] = useState(start ? dayKey(start) : tomorrow());
  const [time, setTime] = useState(start ? clock(start) : '10:00');
  const [minutes, setMinutes] = useState(length);
  const [ownLink, setOwnLink] = useState<boolean | null>(
    interview?.meeting_url ? true : null,
  );
  const [meetingUrl, setMeetingUrl] = useState(interview?.meeting_url ?? '');
  const [location, setLocation] = useState(interview?.location ?? '');
  const [panel, setPanel] = useState<string[] | null>(
    interview?.panelist_ids ?? null,
  );
  const [invite, setInvite] = useState<boolean | null>(
    interview ? false : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const calendar = useCalendarStatus(true);
  const connected = calendar.data?.connected ?? [];
  const [pick, setPick] = useState<CalendarProvider | null>(null);
  const panelists = useQuery({
    queryKey: ['interview-panelists'],
    queryFn: () => api<{ data: Panelist[] }>('/interviews/panelists'),
    retry: false,
  });
  const people = panelists.data?.data ?? [];
  // You, by default, when you can sit on the panel.
  const chosen =
    panel ?? (userId && people.some((p) => p.id === userId) ? [userId] : []);
  const onCalendar = !!interview?.on_calendar;
  // In its calendar already, else the one chosen here or the organization's.
  const provider: CalendarProvider | null = onCalendar
    ? (interview?.calendar_provider ?? null)
    : (pick ?? calendar.data?.provider ?? null);
  // New interviews go in the calendar by default, when there is one.
  const inviting = !!provider && !onCalendar && (invite ?? true);
  const calendarInPlay = onCalendar || inviting;
  // The calendar creates the meeting unless you give your own link.
  const linkFromCalendar =
    mode === 'VIDEO' && calendarInPlay && !!provider && !(ownLink ?? false);
  const lengths = ['30', '45', '60', '90'];
  if (!lengths.includes(length)) lengths.push(length);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const startsAt = new Date(`${day}T${time}`);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      setError('Choose a date and time in the future.');
      return;
    }
    if (!chosen.length) {
      setError('Choose at least one person for the interview panel.');
      return;
    }
    const endsAt = new Date(startsAt.getTime() + Number(minutes) * 60_000);
    const chosenTime = {
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    };
    const venue = {
      meetingUrl:
        mode === 'VIDEO' && !linkFromCalendar ? meetingUrl.trim() : null,
      location: mode === 'ONSITE' ? location.trim() : null,
    };
    setBusy(true);
    try {
      if (interview) {
        const saved = await api<Saved>(`/interviews/${interview.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            round: round.trim() || interview.round,
            mode,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            ...venue,
            panelistIds: chosen,
            ...(inviting
              ? { sendInvitations: true, calendarProvider: provider }
              : {}),
          }),
        });
        const [notice, problem] = savedMessage(
          saved,
          `Interview moved to ${whenLabel(chosenTime)}.`,
        );
        await onSaved(notice, problem);
        return;
      }
      const saved = await api<Saved>('/interviews', {
        method: 'POST',
        body: JSON.stringify({
          applicationId: application.id,
          round: round.trim() || 'Interview',
          mode,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          ...(venue.meetingUrl ? { meetingUrl: venue.meetingUrl } : {}),
          ...(venue.location ? { location: venue.location } : {}),
          panelistIds: chosen,
          sendInvitations: inviting,
          ...(inviting ? { calendarProvider: provider } : {}),
        }),
      });
      // Scheduling an interview moves a shortlisted candidate on.
      let moved = '';
      if (application.stage === 'SHORTLISTED')
        try {
          await api(`/applications/${application.id}/stage`, {
            method: 'PATCH',
            body: JSON.stringify({ stage: 'INTERVIEW' }),
          });
          moved = ' and moved them to In Interview';
        } catch {
          moved = ', but they couldn’t be moved to In Interview';
        }
      const [notice, problem] = savedMessage(
        saved,
        `Interview scheduled for ${application.candidateName} on ${whenLabel(chosenTime)}${moved}.`,
      );
      await onSaved(notice, problem);
    } catch (reason) {
      setError(
        message(
          reason,
          interview
            ? 'The interview couldn’t be rescheduled.'
            : 'The interview couldn’t be scheduled.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={interview ? 'Reschedule interview' : 'Schedule interview'}
      subtitle={`${application.candidateName} · ${application.jobTitle}`}
      onClose={onClose}
    >
      <form className="cand-form" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          Round
          <input
            value={round}
            maxLength={100}
            required
            onChange={(event) => setRound(event.target.value)}
          />
        </label>
        <div className="cand-form-row">
          <Select
            label="Type"
            value={mode}
            onChange={(value) => setMode(value as InterviewMode)}
            options={(Object.keys(modeLabels) as InterviewMode[]).map((m) => [
              m,
              modeLabels[m],
            ])}
          />
          <Select
            label="Length"
            value={minutes}
            onChange={setMinutes}
            options={lengths.map((m) => [m, `${m} minutes`])}
          />
        </div>
        <div className="cand-form-row">
          <label className="form-field">
            Date
            <input
              type="date"
              value={day}
              required
              onChange={(event) => setDay(event.target.value)}
            />
          </label>
          <label className="form-field">
            Start time
            <input
              type="time"
              value={time}
              required
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
        </div>
        {mode === 'VIDEO' &&
          (calendarInPlay && provider ? (
            <fieldset className="iv-choice">
              <legend>Meeting link</legend>
              <label>
                <input
                  type="radio"
                  name="meeting-link"
                  checked={linkFromCalendar}
                  onChange={() => setOwnLink(false)}
                />
                Create a {meetingNames[provider]} link
              </label>
              <label>
                <input
                  type="radio"
                  name="meeting-link"
                  checked={!linkFromCalendar}
                  onChange={() => setOwnLink(true)}
                />
                Use my own link
              </label>
              {!linkFromCalendar && (
                <input
                  type="url"
                  aria-label="Your meeting link"
                  value={meetingUrl}
                  required
                  placeholder="https://…"
                  pattern="https://.*"
                  onChange={(event) => setMeetingUrl(event.target.value)}
                />
              )}
            </fieldset>
          ) : (
            <label className="form-field">
              Meeting link
              <input
                type="url"
                value={meetingUrl}
                required
                placeholder="https://meet.google.com/…"
                pattern="https://.*"
                onChange={(event) => setMeetingUrl(event.target.value)}
              />
            </label>
          ))}
        {mode === 'ONSITE' && (
          <label className="form-field">
            Location
            <input
              value={location}
              required
              maxLength={1000}
              placeholder="Office address and room"
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
        )}
        <fieldset className="cand-panelists">
          <legend>Interview panel</legend>
          {panelists.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : panelists.isError ? (
            <p className="form-error">
              {message(panelists.error, 'The team couldn’t be loaded.')}
            </p>
          ) : people.length === 0 ? (
            <p className="cand-muted">
              No one can sit on a panel yet. Invite interviewers in Team &amp;
              invitations.
            </p>
          ) : (
            people.map((person) => (
              <label key={person.id} className="cand-panelist">
                <input
                  type="checkbox"
                  checked={chosen.includes(person.id)}
                  onChange={(event) =>
                    setPanel(
                      event.target.checked
                        ? [...chosen, person.id]
                        : chosen.filter((id) => id !== person.id),
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
        <div className="iv-calendar-note">
          {calendar.isPending ? null : onCalendar && provider ? (
            <p>
              <FontAwesomeIcon icon={faCalendarCheck} aria-hidden="true" /> The{' '}
              {calendarNames[provider]} event changes too, and everyone invited
              is told.
            </p>
          ) : provider ? (
            <>
              <label className="iv-check">
                <input
                  type="checkbox"
                  checked={inviting}
                  onChange={(event) => setInvite(event.target.checked)}
                />
                <span>
                  {connected.length > 1
                    ? 'Add to a calendar and invite the panel and the candidate'
                    : `Add to ${calendarNames[provider]} and invite the panel and the candidate`}
                  <small>
                    It appears in everyone’s calendar, and they’re emailed about
                    changes.
                  </small>
                </span>
              </label>
              {inviting && connected.length > 1 && (
                <Select
                  label="Calendar"
                  value={provider}
                  onChange={(value) => setPick(value as CalendarProvider)}
                  options={connected.map((c) => [c, calendarNames[c]])}
                />
              )}
            </>
          ) : (
            <p className="cand-muted">
              Only saved in HireAI. To add interviews to calendars and email
              invitations, an HR Admin connects Google Calendar or Microsoft
              Calendar in Integrations.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="cand-form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={busy}>
            {busy
              ? 'Saving…'
              : interview
                ? 'Save changes'
                : 'Schedule interview'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CancelForm({
  interview,
  onClose,
  onDone,
}: {
  interview: Interview;
  onClose: () => void;
  onDone: (notice: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/interviews/${interview.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await onDone(
        interview.on_calendar && interview.calendar_provider
          ? `Interview cancelled. ${calendarNames[interview.calendar_provider]} told everyone invited.`
          : 'Interview cancelled.',
      );
    } catch (failure) {
      setError(message(failure, 'The interview couldn’t be cancelled.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Cancel interview"
      subtitle={`${interview.round} · ${candidateOf(interview)} · ${whenLabel(interview)}`}
      onClose={onClose}
    >
      <form className="cand-form" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          Reason
          <textarea
            value={reason}
            required
            maxLength={1000}
            rows={3}
            placeholder="Kept in the audit log"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {interview.on_calendar && (
          <p className="cand-muted">
            The calendar event is removed, and the panel and the candidate are
            told.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="cand-form-actions">
          <button type="button" onClick={onClose}>
            Keep interview
          </button>
          <button
            type="submit"
            className="button-primary"
            disabled={busy || !reason.trim()}
          >
            {busy ? 'Cancelling…' : 'Cancel interview'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A panelist's feedback: a score per criterion and a recommendation. */
function FeedbackForm({
  interview,
  onClose,
  onDone,
}: {
  interview: Interview;
  onClose: () => void;
  onDone: (notice: string) => Promise<void> | void;
}) {
  const criteria = interview.criteria_snapshot;
  const [scores, setScores] = useState<Record<string, string>>({});
  const [recommendation, setRecommendation] = useState<Recommendation | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (criteria.some((c) => scores[c.id] === undefined)) {
      setError('Score every criterion.');
      return;
    }
    if (!recommendation) {
      setError('Choose a recommendation.');
      return;
    }
    setBusy(true);
    try {
      await api(`/interviews/${interview.id}/scorecards`, {
        method: 'POST',
        body: JSON.stringify({
          scores: criteria.map((c) => ({
            criterionId: c.id,
            score: Number(scores[c.id]),
          })),
          recommendation,
          notes: notes.trim(),
        }),
      });
      await onDone(`Feedback for ${candidateOf(interview)} submitted.`);
    } catch (failure) {
      setError(message(failure, 'The feedback couldn’t be submitted.'));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Interview feedback"
      subtitle={`${interview.round} · ${candidateOf(interview)} · ${interview.job_title}`}
      onClose={onClose}
    >
      <form className="cand-form" onSubmit={(event) => void submit(event)}>
        {criteria.length > 0 ? (
          <fieldset className="iv-scores">
            <legend>Scores (0 to 5)</legend>
            {criteria.map((criterion) => (
              <Select
                key={criterion.id}
                label={criterion.label}
                value={scores[criterion.id] ?? ''}
                onChange={(value) =>
                  setScores({ ...scores, [criterion.id]: value })
                }
                options={[
                  ['', 'Choose a score'],
                  ...[5, 4, 3, 2, 1, 0].map(
                    (score) =>
                      [String(score), `${score} – ${scoreLabels[score]}`] as [
                        string,
                        string,
                      ],
                  ),
                ]}
              />
            ))}
          </fieldset>
        ) : (
          <p className="cand-muted">
            The job had no screening criteria when this interview was scheduled,
            so there’s nothing to score: give a recommendation.
          </p>
        )}
        <fieldset className="iv-choice">
          <legend>Recommendation</legend>
          {(Object.keys(recommendationLabels) as Recommendation[]).map(
            (value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="recommendation"
                  checked={recommendation === value}
                  onChange={() => setRecommendation(value)}
                />
                {recommendationLabels[value]}
              </label>
            ),
          )}
        </fieldset>
        <label className="form-field">
          Notes
          <textarea
            value={notes}
            maxLength={5000}
            rows={4}
            placeholder="What you saw, for the hiring decision"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <p className="cand-muted">
          Feedback can’t be changed once it’s submitted. Other panelists don’t
          see it; recruiters do.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="cand-form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FeedbackList({ interview }: { interview: Interview }) {
  const cards = useQuery({
    queryKey: ['interviews', 'scorecards', interview.id],
    queryFn: () => api<Scorecard[]>(`/interviews/${interview.id}/scorecards`),
    retry: false,
  });
  if (cards.isPending) return <p className="cand-muted">Loading…</p>;
  if (cards.isError)
    return (
      <p role="alert" className="form-error">
        {message(cards.error, 'The feedback couldn’t be loaded.')}
      </p>
    );
  if (!cards.data.length) return <p className="cand-muted">No feedback yet.</p>;
  const names = new Map(interview.panel.map((p) => [p.id, p.full_name]));
  const labels = new Map(interview.criteria_snapshot.map((c) => [c.id, c]));
  return (
    <ul className="iv-feedback">
      {cards.data.map((card) => {
        const average = card.scores.length
          ? card.scores.reduce((sum, s) => sum + s.score, 0) /
            card.scores.length
          : null;
        return (
          <li key={card.id}>
            <div className="iv-feedback-head">
              <strong>{names.get(card.panelist_user_id) ?? 'Panelist'}</strong>
              <span
                className={`iv-chip iv-rec-${card.recommendation.toLowerCase()}`}
              >
                {recommendationLabels[card.recommendation]}
              </span>
              {average !== null && (
                <span className="cand-muted">
                  Average {average.toFixed(1)} / 5
                </span>
              )}
            </div>
            {card.scores.length > 0 && (
              <ul className="iv-feedback-scores">
                {card.scores.map((score) => (
                  <li key={score.criterionId}>
                    {labels.get(score.criterionId)?.label ?? score.criterionId}:{' '}
                    <strong>{score.score}</strong> ({scoreLabels[score.score]})
                  </li>
                ))}
              </ul>
            )}
            {card.notes && <p className="iv-feedback-notes">{card.notes}</p>}
            <small className="cand-muted">
              Submitted {dayFormat.format(new Date(card.submitted_at))}
            </small>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * An interview's details, with what the viewer may do: reschedule, cancel
 * or add it to the calendar (recruiters), and give feedback (the panel).
 */
export function InterviewDetails({
  interviewId,
  onClose,
  onNotice,
}: {
  interviewId: string;
  onClose: () => void;
  onNotice?: (notice: string, problem: string) => void;
}) {
  const refresh = useRefresh();
  const userId = useAuth().session?.user.id;
  const canManage = useCanManageInterviews();
  const [view, setView] = useState<
    'details' | 'reschedule' | 'cancel' | 'feedback'
  >('details');
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState('');
  const [info, setInfo] = useState('');
  const query = useQuery({
    queryKey: ['interviews', 'one', interviewId],
    queryFn: () => api<Interview>(`/interviews/${interviewId}`),
    retry: false,
  });
  const calendar = useCalendarStatus(canManage);
  const provider = calendar.data?.provider ?? null;
  const connected = calendar.data?.connected ?? [];
  const interview = query.data;

  async function finish(notice: string, failure = '') {
    await refresh();
    onNotice?.(notice, failure);
    onClose();
  }

  /** Adds it to a calendar, sends it again, or moves it to another one. */
  async function addToCalendar(calendarProvider?: CalendarProvider) {
    if (!interview) return;
    setAdding(true);
    setProblem('');
    setInfo('');
    try {
      const saved = await api<Saved>(`/interviews/${interview.id}/calendar`, {
        method: 'POST',
        body: JSON.stringify(calendarProvider ? { calendarProvider } : {}),
      });
      const [notice, failure] = savedMessage(saved, '');
      await refresh();
      setInfo(notice.trim());
      setProblem(failure);
      onNotice?.(notice.trim(), failure);
    } catch (failure) {
      setProblem(message(failure, 'It couldn’t be added to the calendar.'));
    } finally {
      setAdding(false);
    }
  }

  if (!interview)
    return (
      <Modal title="Interview" onClose={onClose}>
        <div className="iv-details">
          {query.isError ? (
            <p role="alert" className="form-error">
              {message(query.error, 'This interview couldn’t be loaded.')}
            </p>
          ) : (
            <p role="status" className="cand-state">
              Loading…
            </p>
          )}
        </div>
      </Modal>
    );

  const application: InterviewFor = {
    id: interview.application_id,
    candidateName: candidateOf(interview),
    jobTitle: interview.job_title,
    stage: interview.application_stage,
  };
  if (view === 'reschedule')
    return (
      <InterviewForm
        application={application}
        interview={interview}
        onClose={() => setView('details')}
        onSaved={(notice, failure) => finish(notice, failure)}
      />
    );
  if (view === 'cancel')
    return (
      <CancelForm
        interview={interview}
        onClose={() => setView('details')}
        onDone={(notice) => finish(notice)}
      />
    );
  if (view === 'feedback')
    return (
      <FeedbackForm
        interview={interview}
        onClose={() => setView('details')}
        onDone={(notice) => finish(notice)}
      />
    );

  const current = phase(interview);
  const open = current === 'upcoming' || current === 'live';
  const onPanel = !!userId && interview.panelist_ids.includes(userId);
  const canGiveFeedback =
    onPanel &&
    !interview.my_scorecard &&
    interview.status === 'SCHEDULED' &&
    current !== 'upcoming';
  const name = interview.calendar_provider
    ? calendarNames[interview.calendar_provider]
    : provider
      ? calendarNames[provider]
      : 'the calendar';
  return (
    <Modal
      title={`${interview.round}: ${candidateOf(interview)}`}
      subtitle={interview.job_title}
      onClose={onClose}
      wide
    >
      <div className="iv-details">
        <p className="iv-chips">
          <PhaseChip interview={interview} />
          <CalendarChip interview={interview} />
        </p>
        <dl className="iv-facts">
          <div>
            <dt>When</dt>
            <dd>
              {whenLabel(interview)}
              <small>
                {minutesBetween(interview.starts_at, interview.ends_at)}{' '}
                minutes, in your time zone
              </small>
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>
              <FontAwesomeIcon
                icon={modeIcons[interview.mode]}
                aria-hidden="true"
              />{' '}
              {modeLabels[interview.mode]}
            </dd>
          </div>
          {interview.mode === 'VIDEO' && (
            <div>
              <dt>Join</dt>
              <dd>
                {interview.meeting_url ? (
                  <a
                    href={interview.meeting_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {interview.meeting_url}
                  </a>
                ) : (
                  'No meeting link yet: add one by rescheduling, or add the interview to the calendar to create one.'
                )}
              </dd>
            </div>
          )}
          {interview.mode === 'ONSITE' && interview.location && (
            <div>
              <dt>Location</dt>
              <dd>{interview.location}</dd>
            </div>
          )}
          <div>
            <dt>Panel</dt>
            <dd>
              <ul className="iv-panel">
                {interview.panel.map((person) => (
                  <li key={person.id}>
                    {person.full_name}
                    <small>{roleLabel(person.role as Role)}</small>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt>Scheduled by</dt>
            <dd>
              {interview.created_by
                ? (interview.created_by_name ?? 'A recruiter')
                : 'The AI assistant, on a call with the candidate'}
            </dd>
          </div>
          {interview.status === 'SCHEDULED' && (
            <div>
              <dt>Calendar</dt>
              <dd>
                {interview.on_calendar
                  ? `In ${name}. The panel and the candidate were invited, so it’s in their calendars too.`
                  : 'Not in a calendar: nobody was sent an invitation.'}
                {canManage && open && provider && (
                  <span className="iv-inline-actions">
                    {interview.on_calendar && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={adding}
                        onClick={() => void addToCalendar()}
                      >
                        Send the invitation again
                      </button>
                    )}
                    {connected
                      .filter(
                        (c) =>
                          !interview.on_calendar ||
                          c !== interview.calendar_provider,
                      )
                      .map((c) => (
                        <button
                          key={c}
                          type="button"
                          className="text-button"
                          disabled={adding}
                          onClick={() => void addToCalendar(c)}
                        >
                          {interview.on_calendar
                            ? `Move to ${calendarNames[c]}`
                            : `Add to ${calendarNames[c]}`}
                        </button>
                      ))}
                    {adding && <span className="cand-muted">Saving…</span>}
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
        {info && (
          <p role="status" className="form-success">
            {info}
          </p>
        )}
        {problem && (
          <p role="alert" className="form-error">
            <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden="true" />{' '}
            {problem}
          </p>
        )}
        <section className="iv-section">
          <h3>
            Feedback
            {interview.scorecard_count !== null && (
              <small>
                {interview.scorecard_count} of{' '}
                {plural(interview.panel.length, 'panelist')}
              </small>
            )}
          </h3>
          {interview.status === 'CANCELLED' ? (
            <p className="cand-muted">This interview was cancelled.</p>
          ) : current === 'upcoming' && !interview.scorecard_count ? (
            <p className="cand-muted">
              The panel gives feedback once the interview has started.
            </p>
          ) : (
            <FeedbackList interview={interview} />
          )}
        </section>
        <div className="cand-form-actions iv-actions">
          {canManage && open && (
            <>
              <button type="button" onClick={() => setView('cancel')}>
                Cancel interview
              </button>
              <button type="button" onClick={() => setView('reschedule')}>
                Reschedule
              </button>
            </>
          )}
          {canGiveFeedback && (
            <button
              type="button"
              className="button-primary"
              onClick={() => setView('feedback')}
            >
              Give feedback
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** One interview, as a card in a list. */
function InterviewCard({
  interview,
  onOpen,
  showCandidate = false,
}: {
  interview: Interview;
  onOpen: () => void;
  showCandidate?: boolean;
}) {
  const start = new Date(interview.starts_at);
  return (
    <li className={`iv-card iv-card-${phase(interview)}`}>
      <button
        type="button"
        className="iv-card-button"
        aria-label={`${interview.round} with ${candidateOf(interview)}, ${whenLabel(interview)}`}
        onClick={onOpen}
      >
        <span className="iv-date" aria-hidden="true">
          <small>
            {start.toLocaleDateString(undefined, { month: 'short' })}
          </small>
          <strong>{start.getDate()}</strong>
        </span>
        <span className="iv-card-body">
          <strong>
            {showCandidate
              ? `${candidateOf(interview)} · ${interview.round}`
              : interview.round}
          </strong>
          <span>{whenLabel(interview)}</span>
          <span className="cand-muted">
            <FontAwesomeIcon
              icon={modeIcons[interview.mode]}
              aria-hidden="true"
            />{' '}
            {modeLabels[interview.mode]}
            {interview.mode === 'ONSITE' && interview.location
              ? ` · ${interview.location}`
              : ''}{' '}
            · <FontAwesomeIcon icon={faUsers} aria-hidden="true" />{' '}
            {interview.panel.map((p) => p.full_name).join(', ')}
          </span>
          <span className="iv-chips">
            <PhaseChip interview={interview} />
            <CalendarChip interview={interview} />
          </span>
        </span>
      </button>
      {interview.mode === 'VIDEO' &&
        interview.meeting_url &&
        phase(interview) !== 'done' &&
        interview.status === 'SCHEDULED' && (
          <a
            className="iv-join"
            href={interview.meeting_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Join
          </a>
        )}
    </li>
  );
}

/**
 * An application's interviews, for the application and candidate views:
 * when, how, who, whether it's in the calendar, and its feedback.
 */
export function ApplicationInterviews({
  applicationId,
  onNotice,
}: {
  applicationId: string;
  onNotice?: (notice: string, problem: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['interviews', 'application', applicationId],
    queryFn: () =>
      api<Page>(`/interviews?applicationId=${applicationId}&limit=50`),
    retry: false,
  });
  const interviews = query.data?.data ?? [];
  return (
    <>
      {query.isPending ? (
        <p className="cand-muted">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="form-error">
          {message(query.error, 'The interviews couldn’t be loaded.')}
        </p>
      ) : interviews.length === 0 ? (
        <p className="cand-muted">No interviews scheduled.</p>
      ) : (
        <ul className="iv-cards">
          {interviews.map((interview) => (
            <InterviewCard
              key={interview.id}
              interview={interview}
              onOpen={() => setOpen(interview.id)}
            />
          ))}
        </ul>
      )}
      {open && (
        <InterviewDetails
          interviewId={open}
          onClose={() => setOpen(null)}
          onNotice={onNotice}
        />
      )}
    </>
  );
}

/** The weeks shown for a month, Monday first. */
function monthDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const length = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const weeks = Math.ceil((offset + length) / 7);
  return Array.from(
    { length: weeks * 7 },
    (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i),
  );
}

/** Every interview overlapping a time range (pages of 100). */
async function interviewsBetween(from: Date, to: Date) {
  const all: Interview[] = [];
  const range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await api<Page>(
      `/interviews?${range}&limit=100&offset=${offset}`,
    );
    all.push(...page.data);
    if (all.length >= page.total || !page.data.length) break;
  }
  return all;
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MonthCalendar({ onOpen }: { onOpen: (id: string) => void }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const days = monthDays(month);
  const from = days[0];
  const to = new Date(
    days.at(-1)!.getFullYear(),
    days.at(-1)!.getMonth(),
    days.at(-1)!.getDate() + 1,
  );
  const query = useQuery({
    queryKey: ['interviews', 'month', dayKey(month)],
    queryFn: () => interviewsBetween(from, to),
    retry: false,
    placeholderData: (previous) => previous,
  });
  const byDay = new Map<string, Interview[]>();
  for (const interview of query.data ?? []) {
    const key = dayKey(new Date(interview.starts_at));
    byDay.set(key, [...(byDay.get(key) ?? []), interview]);
  }
  const today = dayKey(new Date());
  const chosen = byDay.get(selected) ?? [];
  const move = (by: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + by, 1);
    setMonth(next);
    setSelected(dayKey(next));
  };
  const monthLabel = month.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  return (
    <div className="iv-month">
      <div className="iv-month-bar">
        <h2>{monthLabel}</h2>
        <div className="iv-month-nav">
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Previous month"
            onClick={() => move(-1)}
          >
            <FontAwesomeIcon icon={faChevronLeft} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
              setSelected(dayKey(now));
            }}
          >
            Today
          </button>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Next month"
            onClick={() => move(1)}
          >
            <FontAwesomeIcon icon={faChevronRight} aria-hidden="true" />
          </button>
        </div>
      </div>
      {query.isError && (
        <p role="alert" className="form-error">
          {message(query.error, 'The interviews couldn’t be loaded.')}
        </p>
      )}
      <div className="iv-grid" role="grid" aria-label={monthLabel}>
        <div className="iv-grid-row" role="row">
          {weekdays.map((day) => (
            <span key={day} role="columnheader" className="iv-weekday">
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: days.length / 7 }, (_, week) => (
          <div key={week} className="iv-grid-row" role="row">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const key = dayKey(day);
              const items = byDay.get(key) ?? [];
              const outside = day.getMonth() !== month.getMonth();
              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-selected={key === selected}
                  className={[
                    'iv-day',
                    outside ? 'iv-day-outside' : '',
                    key === today ? 'iv-day-today' : '',
                    key === selected ? 'iv-day-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className="iv-day-number"
                    aria-label={`${day.toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}: ${plural(items.length, 'interview')}`}
                    onClick={() => setSelected(key)}
                  >
                    {day.getDate()}
                  </button>
                  {items.length > 0 && (
                    <span className="iv-dots" aria-hidden="true">
                      {items.slice(0, 4).map((item) => (
                        <i key={item.id} className={`iv-dot-${phase(item)}`} />
                      ))}
                    </span>
                  )}
                  <ul className="iv-day-items">
                    {items.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`iv-event iv-event-${phase(item)}`}
                          onClick={() => onOpen(item.id)}
                        >
                          <span>
                            {timeFormat.format(new Date(item.starts_at))}
                          </span>{' '}
                          {candidateOf(item)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <section className="iv-agenda" aria-live="polite">
        <h3>
          {new Date(`${selected}T00:00`).toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </h3>
        {query.isPending ? (
          <p className="cand-muted">Loading…</p>
        ) : chosen.length === 0 ? (
          <p className="cand-muted">No interviews on this day.</p>
        ) : (
          <ul className="iv-cards">
            {chosen.map((interview) => (
              <InterviewCard
                key={interview.id}
                interview={interview}
                showCandidate
                onOpen={() => onOpen(interview.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const PAGE_SIZE = 20;
const listTabs = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;
type ListTab = (typeof listTabs)[number]['id'];

function InterviewList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<ListTab>('upcoming');
  const [offset, setOffset] = useState(0);
  const filter = tab === 'cancelled' ? 'status=CANCELLED' : `when=${tab}`;
  const query = useQuery({
    queryKey: ['interviews', 'list', tab, offset],
    queryFn: () =>
      api<Page>(`/interviews?${filter}&limit=${PAGE_SIZE}&offset=${offset}`),
    retry: false,
    placeholderData: (previous) => previous,
  });
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  return (
    <div className="iv-list">
      <div className="cand-tabs" role="tablist" aria-label="Interviews">
        {listTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : undefined}
            onClick={() => {
              setTab(item.id);
              setOffset(0);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <p role="status" className="cand-state">
          Loading…
        </p>
      ) : query.isError ? (
        <p role="alert" className="form-error">
          {message(query.error, 'The interviews couldn’t be loaded.')}
        </p>
      ) : rows.length === 0 ? (
        <p className="cand-state">
          {tab === 'upcoming'
            ? 'No upcoming interviews. Schedule one from Candidates.'
            : tab === 'past'
              ? 'No past interviews yet.'
              : 'No cancelled interviews.'}
        </p>
      ) : (
        <div className="iv-table-wrap">
          <table className="iv-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Candidate</th>
                <th scope="col">Round</th>
                <th scope="col">Type</th>
                <th scope="col">Panel</th>
                <th scope="col">Feedback</th>
                <th scope="col">Calendar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((interview) => (
                <tr key={interview.id}>
                  <td>
                    <button
                      type="button"
                      className="text-button iv-row-open"
                      onClick={() => onOpen(interview.id)}
                    >
                      {whenLabel(interview)}
                    </button>
                  </td>
                  <td>
                    {candidateOf(interview)}
                    <small>{interview.job_title}</small>
                  </td>
                  <td>{interview.round}</td>
                  <td>{modeLabels[interview.mode]}</td>
                  <td>{interview.panel.map((p) => p.full_name).join(', ')}</td>
                  <td>{feedbackLabel(interview)}</td>
                  <td>
                    <CalendarChip interview={interview} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE_SIZE && (
        <div className="cand-pager">
          <p>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <nav aria-label="Pages">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}

export function InterviewsPage() {
  const titleId = useId();
  const canManage = useCanManageInterviews();
  const isAdmin = useAuth().session?.user.role === 'HR_ADMIN';
  const calendar = useCalendarStatus(canManage);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  // ?interview=… opens one, e.g. from a hiring manager's home.
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpenState] = useState<string | null>(
    searchParams.get('interview'),
  );
  const setOpen = (id: string | null) => {
    setOpenState(id);
    if (!id && searchParams.has('interview'))
      setSearchParams({}, { replace: true });
  };
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const provider = calendar.data?.provider;
  return (
    <section className="cand-page iv-page" aria-labelledby={titleId}>
      <header className="cand-heading">
        <div>
          <h1 id={titleId}>Interviews</h1>
          <p className="intro">
            {canManage
              ? 'Every interview, in a calendar or a list. Schedule them from Candidates.'
              : 'The interviews you’re on, and your feedback.'}
          </p>
        </div>
        <div className="iv-views" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'calendar'}
            className={view === 'calendar' ? 'active' : undefined}
            onClick={() => setView('calendar')}
          >
            <FontAwesomeIcon icon={faCalendarDays} aria-hidden="true" />{' '}
            Calendar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={view === 'list' ? 'active' : undefined}
            onClick={() => setView('list')}
          >
            <FontAwesomeIcon icon={faList} aria-hidden="true" /> List
          </button>
        </div>
      </header>
      {canManage && calendar.isSuccess && (
        <p className={`iv-banner${provider ? '' : ' iv-banner-off'}`}>
          <FontAwesomeIcon
            icon={provider ? faCalendarCheck : faTriangleExclamation}
            aria-hidden="true"
          />
          <span>
            {provider ? (
              <>
                Interviews go in your connected {calendarNames[provider]}: the
                panel and the candidate are invited, so they appear in their
                calendars too.
                {(calendar.data?.connected.length ?? 0) > 1 &&
                  (isAdmin ? (
                    <>
                      {' '}
                      <Link to="/integrations">Change the calendar</Link>
                    </>
                  ) : (
                    ' You can pick the other connected calendar when scheduling.'
                  ))}
              </>
            ) : (
              <>
                No calendar is connected, so interviews are only in HireAI and
                nobody is sent an invitation.{' '}
                {isAdmin ? (
                  <Link to="/integrations">
                    Connect Google Calendar or Microsoft Calendar
                  </Link>
                ) : (
                  'An HR Admin can connect Google Calendar or Microsoft Calendar in Integrations.'
                )}
              </>
            )}
          </span>
        </p>
      )}
      {(notice || problem) && (
        <div className="cand-notice">
          {notice && (
            <p role="status" className="form-success">
              {notice}
            </p>
          )}
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Dismiss"
            onClick={() => {
              setNotice('');
              setProblem('');
            }}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="iv-panel-card">
        {view === 'calendar' ? (
          <MonthCalendar onOpen={setOpen} />
        ) : (
          <InterviewList onOpen={setOpen} />
        )}
      </div>
      {open && (
        <InterviewDetails
          interviewId={open}
          onClose={() => setOpen(null)}
          onNotice={(text, failure) => {
            setNotice(text);
            setProblem(failure);
          }}
        />
      )}
    </section>
  );
}
