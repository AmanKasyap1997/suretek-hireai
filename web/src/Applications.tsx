import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faDownload,
  faFileLines,
  faTriangleExclamation,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api, ApiError } from './api';
import { CallPanel, JobCallsBar } from './Calls';
import { ApplicationInterviews } from './Interviews';
import { useAuth } from './auth';
import {
  formatExperience,
  formatPay,
  noticePeriodLabels,
  sourceLabels,
} from './Careers';

type Page<T> = { data: T[]; total: number };
export type ScreeningStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type Fit = 'STRONG' | 'GOOD' | 'PARTIAL' | 'WEAK';
type Rating = 'MEETS' | 'PARTIAL' | 'NOT_MET' | 'UNCLEAR';
type Row = {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: string;
  created_at: string;
  job_title: string;
  candidate_name: string;
  current_location: string | null;
  total_experience_months: number | null;
  notice_period: keyof typeof noticePeriodLabels | null;
  source: keyof typeof sourceLabels | null;
  screening_status: ScreeningStatus | null;
  screening_score: number | null;
  screening_fit: Fit | null;
  screening_missing_must_have: boolean | null;
};
export type Document = {
  id: string;
  original_name: string;
  byte_size: number;
  scan_status: string;
  created_at: string;
  sent_with?: 'this_application' | 'another_application' | 'uploaded_by_staff';
};
export type Details = {
  id: string;
  stage: string;
  created_at: string;
  job: { id: string; title: string };
  candidate: {
    id: string;
    full_name: string;
    erased: boolean;
    email: string | null;
    phone: string | null;
  };
  details: {
    current_location: string;
    willing_to_relocate: boolean | null;
    total_experience_months: number;
    current_company: string | null;
    current_title: string | null;
    notice_period: keyof typeof noticePeriodLabels;
    last_working_day: string | null;
    current_ctc: number | null;
    expected_ctc: number | null;
    ctc_currency: string | null;
    linkedin_url: string | null;
    portfolio_url: string | null;
    cover_letter: string | null;
    source: keyof typeof sourceLabels;
    referrer: string | null;
  } | null;
  /** The resume for this application (at most one). */
  documents: Document[];
  /** The candidate's resumes from other applications or uploads. */
  other_resumes?: number;
  pay_and_contact_hidden: boolean;
};
type Criterion = {
  id: string;
  label: string;
  weight: number;
  must_have: boolean;
  rating: Rating;
  evidence: string;
  reason: string;
};
export type Screening = {
  id: string;
  status: ScreeningStatus;
  trigger: 'AUTOMATIC' | 'MANUAL' | 'BATCH';
  score: number | null;
  fit: Fit | null;
  missing_must_have: boolean | null;
  result: {
    criteria: Criterion[];
    derived_criteria: boolean;
    summary: string;
    strengths: string[];
    concerns: string[];
    questions: string[];
    /** Skills found in the resume (screenings from before: none). */
    skills?: string[];
    instructions_in_resume: boolean;
  } | null;
  provider_label: string | null;
  model: string | null;
  failure_message: string | null;
  fallback_message?: string | null;
  document_name?: string | null;
  created_at: string;
  completed_at: string | null;
  outdated: boolean;
};
type JobScreening = {
  total: number;
  screened: number;
  in_progress: number;
  failed: number;
  to_screen: number;
  auto_screen: boolean;
  ai_available: boolean;
  /** The provider that screens first, or why none can. */
  ai_provider?: string | null;
  ai_message?: string | null;
};

const stages = [
  'APPLIED',
  'SHORTLISTED',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'REJECTED',
];
export const rejectionReasonLabels = {
  QUALIFICATIONS: 'Qualifications',
  EXPERIENCE: 'Experience',
  COMPENSATION: 'Pay expectations',
  OTHER: 'Other',
};
export const fitLabels: Record<Fit, string> = {
  STRONG: 'Strong match',
  GOOD: 'Good match',
  PARTIAL: 'Partial match',
  WEAK: 'Weak match',
};
const ratingLabels: Record<Rating, string> = {
  MEETS: 'Meets',
  PARTIAL: 'Partly meets',
  NOT_MET: 'Not met',
  UNCLEAR: 'Unclear',
};
const rejectionReasons = rejectionReasonLabels;
const inProgress = (status: ScreeningStatus | null | undefined) =>
  status === 'QUEUED' || status === 'RUNNING';
const sentence = (value: string) => value[0] + value.slice(1).toLowerCase();
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Who may run screenings, and who may read them (the backend decides). */
function useScreeningAccess() {
  const role = useAuth().session?.user.role;
  const canScreen = role === 'HR_ADMIN' || role === 'RECRUITER';
  return {
    role,
    canScreen,
    seesScreening: canScreen || role === 'HIRING_MANAGER',
  };
}

function MatchCell({ row }: { row: Row }) {
  if (row.screening_status === 'COMPLETED' && row.screening_fit)
    return (
      <span className="match-cell">
        <span
          className={`match-score fit-${row.screening_fit.toLowerCase()}`}
          aria-label={`Match score ${row.screening_score} out of 100`}
        >
          {row.screening_score}
        </span>
        <span>
          {fitLabels[row.screening_fit]}
          {row.screening_missing_must_have && (
            <small className="match-missing">
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                aria-hidden="true"
              />{' '}
              Missing a must-have
            </small>
          )}
        </span>
      </span>
    );
  if (inProgress(row.screening_status))
    return <span className="match-pending">Screening…</span>;
  if (row.screening_status === 'FAILED')
    return <span className="match-failed">Screening failed</span>;
  return <span className="match-none">Not screened</span>;
}

export function ApplicationsPage() {
  const queryClient = useQueryClient();
  const { canScreen, seesScreening } = useScreeningAccess();
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get('job') ?? '';
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [sort, setSort] = useState<'created_at' | 'score'>('created_at');
  const [offset, setOffset] = useState(0);
  // ?application=… opens one, e.g. from a hiring manager's home.
  const [open, setOpenState] = useState<string | null>(
    searchParams.get('application'),
  );
  const setOpen = (id: string | null) => {
    setOpenState(id);
    if (!id && searchParams.has('application')) {
      const next = new URLSearchParams(searchParams);
      next.delete('application');
      setSearchParams(next, { replace: true });
    }
  };
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenMessage, setScreenMessage] = useState('');
  const [screenError, setScreenError] = useState('');
  const params = new URLSearchParams({ limit: '25', offset: String(offset) });
  if (search) params.set('q', search);
  if (stage) params.set('stage', stage);
  if (jobId) params.set('jobId', jobId);
  if (sort === 'score') params.set('sort', 'score');
  const list = useQuery({
    queryKey: ['applications', search, stage, jobId, sort, offset],
    queryFn: () => api<Page<Row>>(`/applications?${params.toString()}`),
    // Screenings finish in the background; keep the list current meanwhile.
    refetchInterval: (query) =>
      query.state.data?.data.some((row) => inProgress(row.screening_status))
        ? 4000
        : false,
  });
  const jobs = useQuery({
    queryKey: ['applications-jobs'],
    queryFn: () =>
      api<Page<{ id: string; title: string; status: string }>>(
        '/jobs?limit=100&sort=updated_at&direction=desc',
      ),
  });
  const jobScreening = useQuery({
    queryKey: ['job-screening', jobId],
    queryFn: () => api<JobScreening>(`/jobs/${jobId}/screening`),
    enabled: seesScreening && !!jobId,
    refetchInterval: (query) => (query.state.data?.in_progress ? 4000 : false),
  });
  useEffect(() => {
    setScreenMessage('');
    setScreenError('');
  }, [jobId]);
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const summary = jobScreening.data;

  async function screenJob() {
    setScreenBusy(true);
    setScreenMessage('');
    setScreenError('');
    try {
      const result = await api<{ queued: number; skipped: number }>(
        `/jobs/${jobId}/screening`,
        { method: 'POST' },
      );
      setScreenMessage(
        [
          result.queued
            ? `Screening ${plural(result.queued, 'application')}. Results appear here as each one finishes.`
            : 'Nothing new to screen.',
          result.skipped
            ? `${plural(result.skipped, 'application')} couldn’t be screened, usually because there’s no usable resume.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['applications'] }),
        queryClient.invalidateQueries({ queryKey: ['job-screening', jobId] }),
      ]);
    } catch (error) {
      setScreenError(
        error instanceof Error
          ? error.message
          : 'Screening couldn’t be started. Please try again.',
      );
    } finally {
      setScreenBusy(false);
    }
  }

  return (
    <section className="jobs-page applications-page">
      <header className="jobs-heading">
        <div>
          <p className="eyebrow">TALENT ACQUISITION</p>
          <h1>Applications</h1>
          <p className="intro">
            Everyone who applied, with what they told you on the apply form
            {seesScreening ? ' and how their resume matches the job' : ''}.
          </p>
        </div>
      </header>
      <section className="jobs-panel" aria-label="Applications">
        <div className="jobs-panel-heading">
          <div>
            <h2>All applications</h2>
            <p>{plural(total, 'application')}</p>
          </div>
          <form
            className="jobs-filters"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setSearch(searchText.trim());
              setOffset(0);
            }}
          >
            <label>
              <span className="sr-only">Search applicants</span>
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search name or email"
              />
            </label>
            <label>
              <span className="sr-only">Filter by job</span>
              <span className="select-control">
                <select
                  aria-label="Filter by job"
                  value={jobId}
                  onChange={(event) => {
                    setOffset(0);
                    setSearchParams(
                      event.target.value ? { job: event.target.value } : {},
                      { replace: true },
                    );
                  }}
                >
                  <option value="">All jobs</option>
                  {(jobs.data?.data ?? []).map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.title}
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
            <label>
              <span className="sr-only">Filter by stage</span>
              <span className="select-control">
                <select
                  aria-label="Filter by stage"
                  value={stage}
                  onChange={(event) => {
                    setStage(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All stages</option>
                  {stages.map((item) => (
                    <option key={item} value={item}>
                      {sentence(item)}
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
            {seesScreening && (
              <label>
                <span className="sr-only">Sort applications</span>
                <span className="select-control">
                  <select
                    aria-label="Sort applications"
                    value={sort}
                    onChange={(event) => {
                      setSort(event.target.value as typeof sort);
                      setOffset(0);
                    }}
                  >
                    <option value="created_at">Newest first</option>
                    <option value="score">Best match first</option>
                  </select>
                  <FontAwesomeIcon
                    className="select-chevron"
                    icon={faChevronDown}
                    aria-hidden="true"
                  />
                </span>
              </label>
            )}
            <button type="submit">Search</button>
          </form>
        </div>
        {seesScreening && jobId && summary && (
          <div className="screening-bar">
            <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden="true" />
            <p>
              <strong>AI screening:</strong>{' '}
              {summary.total
                ? `${summary.screened} of ${plural(summary.total, 'application')} screened`
                : 'No applications yet'}
              {summary.in_progress
                ? ` · ${summary.in_progress} in progress`
                : ''}
              {summary.failed ? ` · ${summary.failed} failed` : ''}
              {!summary.ai_available
                ? `. ${summary.ai_message ?? 'An HR Admin must enable an AI provider in Integrations.'}`
                : summary.auto_screen
                  ? `. New applications are screened automatically${summary.ai_provider ? ` with ${summary.ai_provider}` : ''}.`
                  : '. Automatic screening is off for this job.'}
            </p>
            {canScreen && summary.ai_available && summary.to_screen > 0 && (
              <button
                type="button"
                className="button-primary"
                disabled={screenBusy}
                onClick={() => void screenJob()}
              >
                {screenBusy
                  ? 'Starting…'
                  : `Screen ${plural(summary.to_screen, 'unscreened application')}`}
              </button>
            )}
          </div>
        )}
        {screenMessage && (
          <p role="status" className="screening-bar-message">
            {screenMessage}
          </p>
        )}
        {screenError && (
          <p role="alert" className="form-error screening-bar-message">
            {screenError}
          </p>
        )}
        {canScreen && jobId && <JobCallsBar jobId={jobId} />}
        {list.isPending ? (
          <p role="status" className="empty-state">
            Loading applications…
          </p>
        ) : list.isError ? (
          <div role="alert" className="empty-state">
            Applications could not be loaded.{' '}
            <button onClick={() => void list.refetch()}>Retry</button>
          </div>
        ) : rows.length ? (
          <>
            <div className="table-scroll">
              <table className="jobs-table applications-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Job</th>
                    {seesScreening && <th>AI match</th>}
                    <th>Experience</th>
                    <th>Notice period</th>
                    <th>Source</th>
                    <th>Stage</th>
                    <th>Applied</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.candidate_name}</strong>
                        {row.current_location && (
                          <small>{row.current_location}</small>
                        )}
                      </td>
                      <td>{row.job_title}</td>
                      {seesScreening && (
                        <td>
                          <MatchCell row={row} />
                        </td>
                      )}
                      <td>{formatExperience(row.total_experience_months)}</td>
                      <td>
                        {row.notice_period
                          ? noticePeriodLabels[row.notice_period]
                          : '—'}
                      </td>
                      <td>{row.source ? sourceLabels[row.source] : '—'}</td>
                      <td>
                        <span
                          className={`status-pill status-${row.stage.toLowerCase()}`}
                        >
                          {sentence(row.stage)}
                        </span>
                      </td>
                      <td>
                        <time dateTime={row.created_at}>
                          {date(row.created_at)}
                        </time>
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label={`View application from ${row.candidate_name}`}
                          onClick={() => setOpen(row.id)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Showing {Math.min(offset + 1, total)}–
                {Math.min(offset + rows.length, total)} of {total}
              </span>
              <button
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 25))}
              >
                Previous
              </button>
              <button
                disabled={offset + 25 >= total}
                onClick={() => setOffset((value) => value + 25)}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <div className="jobs-empty">
            <span className="icon-tile" aria-hidden="true">
              <FontAwesomeIcon icon={faFileLines} />
            </span>
            <h3>
              {search || stage || jobId
                ? 'No matching applications'
                : 'No applications yet'}
            </h3>
            <p>
              {search || stage || jobId
                ? 'Try another search or filter.'
                : 'Share a published job’s apply link to start receiving applications.'}
            </p>
          </div>
        )}
      </section>
      {open && <ApplicationDialog id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Downloads a candidate's resume through the browser. */
export async function downloadResume(candidateId: string, document: Document) {
  const response = await fetch(
    `/api/v1/candidates/${candidateId}/documents/${document.id}/download`,
    { credentials: 'same-origin', cache: 'no-store' },
  ).catch(() => null);
  if (!response?.ok)
    throw new ApiError(
      response?.status ?? 0,
      response?.status === 409
        ? 'This resume is still being checked for viruses. Try again later.'
        : 'The resume couldn’t be downloaded. Please try again.',
    );
  const url = URL.createObjectURL(await response.blob());
  const link = window.document.createElement('a');
  link.href = url;
  link.download = document.original_name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="application-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Points({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4>{title}</h4>
      <ul className="screening-points">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function ScreeningPanel({
  applicationId,
  hasResume,
}: {
  applicationId: string;
  hasResume: boolean;
}) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const { canScreen } = useScreeningAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['application-screening', applicationId],
    queryFn: () =>
      api<{ screening: Screening | null }>(
        `/applications/${applicationId}/screening`,
      ),
    retry: false,
    refetchInterval: (current) =>
      inProgress(current.state.data?.screening?.status) ? 3000 : false,
  });
  const screening = query.data?.screening ?? null;
  const running = busy || inProgress(screening?.status);

  async function screen() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ screening: Screening | null }>(
        `/applications/${applicationId}/screening`,
        { method: 'POST' },
      );
      queryClient.setQueryData(
        ['application-screening', applicationId],
        result,
      );
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      await queryClient.invalidateQueries({ queryKey: ['job-screening'] });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The resume couldn’t be screened. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const result = screening?.status === 'COMPLETED' ? screening.result : null;
  const missing = result?.criteria.filter(
    (item) => item.must_have && item.rating === 'NOT_MET',
  );
  const met = result?.criteria.filter((item) => item.rating === 'MEETS');
  return (
    <section
      className="application-section screening-panel"
      aria-labelledby={headingId}
    >
      <div className="screening-heading">
        <h3 id={headingId}>
          <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden="true" /> AI
          screening
        </h3>
        {canScreen && hasResume && !query.isPending && !running && (
          <button type="button" onClick={() => void screen()}>
            {screening ? 'Screen again' : 'Screen resume'}
          </button>
        )}
      </div>
      {query.isPending ? (
        <p role="status" className="job-dialog-text">
          Loading screening…
        </p>
      ) : query.isError ? (
        <p className="form-error" role="alert">
          The screening couldn’t be loaded.
        </p>
      ) : running ? (
        <p role="status" className="screening-running">
          Screening the resume… This usually takes under a minute.
        </p>
      ) : !screening ? (
        <p className="job-dialog-text">
          {!hasResume && canScreen
            ? 'Not screened: there’s no resume to screen.'
            : canScreen
              ? 'Not screened yet.'
              : 'Not screened yet. A recruiter can screen this resume.'}
        </p>
      ) : screening.status === 'FAILED' ? (
        <p className="form-error" role="alert">
          {screening.failure_message}
        </p>
      ) : result && screening.fit && screening.score !== null ? (
        <>
          <div className="screening-score">
            <span
              className={`screening-badge fit-${screening.fit.toLowerCase()}`}
            >
              <strong>{screening.score}</strong>
              <small>/100</small>
            </span>
            <span>
              <strong>{fitLabels[screening.fit]}</strong>
              <small>
                Meets {met!.length} of{' '}
                {plural(result.criteria.length, 'requirement')}
              </small>
            </span>
          </div>
          {missing!.length > 0 && (
            <p className="screening-flag">
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                aria-hidden="true"
              />{' '}
              Missing a must-have:{' '}
              {missing!.map((item) => item.label).join('; ')}
            </p>
          )}
          {result.instructions_in_resume && (
            <p className="screening-flag">
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                aria-hidden="true"
              />{' '}
              This resume contains text that tries to instruct AI screeners. It
              was ignored, but check the resume yourself.
            </p>
          )}
          {screening.fallback_message && (
            <p className="screening-note">{screening.fallback_message}</p>
          )}
          {screening.outdated && (
            <p className="screening-note">
              The job’s screening criteria changed after this screening.
              {canScreen ? ' Screen again to use the new criteria.' : ''}
            </p>
          )}
          {result.summary && (
            <p className="screening-summary">{result.summary}</p>
          )}
          <ul className="screening-criteria">
            {result.criteria.map((item) => (
              <li key={item.id}>
                <span
                  className={`screening-rating rating-${item.rating.toLowerCase()}`}
                >
                  {ratingLabels[item.rating]}
                </span>
                <div>
                  <strong>{item.label}</strong>
                  {item.must_have && (
                    <small className="screening-must">Must have</small>
                  )}
                  {item.evidence && (
                    <q className="screening-evidence">{item.evidence}</q>
                  )}
                  {item.reason && <p>{item.reason}</p>}
                </div>
              </li>
            ))}
          </ul>
          {result.derived_criteria && (
            <p className="channel-hint">
              This job has no screening criteria, so the AI chose these
              requirements from the job description.
            </p>
          )}
          <div className="screening-columns">
            <Points title="Strengths" items={result.strengths} />
            <Points title="Concerns" items={result.concerns} />
          </div>
          <Points title="Questions to ask" items={result.questions} />
          <p className="screening-footnote">
            Screened {screening.document_name ?? 'the resume'} with{' '}
            {screening.provider_label}
            {screening.model ? ` (${screening.model})` : ''} on{' '}
            {date(screening.completed_at ?? screening.created_at)}. HireAI works
            out the score from the job’s criteria weights. AI can be wrong, so
            check the resume before you decide.
          </p>
        </>
      ) : null}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The human decision after reviewing an application. */
function DecisionPanel({ value }: { value: Details }) {
  const queryClient = useQueryClient();
  const { role } = useScreeningAccess();
  const headingId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<keyof typeof rejectionReasons | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const recruiter = role === 'HR_ADMIN' || role === 'RECRUITER';
  const manager = role === 'HIRING_MANAGER';
  if (value.candidate.erased || (!recruiter && !manager)) return null;
  const next =
    value.stage === 'APPLIED'
      ? (['SHORTLISTED'] as const)
      : value.stage === 'SHORTLISTED' && recruiter
        ? (['INTERVIEW'] as const)
        : [];
  const canReject = ['APPLIED', 'SHORTLISTED', 'INTERVIEW'].includes(
    value.stage,
  );
  if (!next.length && !canReject && !message) return null;

  async function move(stage: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/applications/${value.id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify(
          stage === 'REJECTED'
            ? {
                stage,
                reasonCode: reason,
                ...(note.trim() ? { note: note.trim() } : {}),
              }
            : { stage },
        ),
      });
      setRejecting(false);
      setReason('');
      setNote('');
      setMessage(
        stage === 'REJECTED'
          ? 'Application rejected.'
          : `Moved to ${sentence(stage)}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['applications'] }),
        queryClient.invalidateQueries({
          queryKey: ['application-details', value.id],
        }),
        queryClient.invalidateQueries({ queryKey: ['job-screening'] }),
      ]);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The decision couldn’t be saved. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="application-section application-decision"
      aria-labelledby={headingId}
    >
      <h3 id={headingId}>Decision</h3>
      {!rejecting ? (
        <div className="application-decision-actions">
          {next.map((stage) => (
            <button
              key={stage}
              type="button"
              className="button-primary"
              disabled={busy}
              onClick={() => void move(stage)}
            >
              {stage === 'SHORTLISTED' ? 'Shortlist' : 'Move to interview'}
            </button>
          ))}
          {canReject && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(true);
                setMessage('');
              }}
            >
              Reject…
            </button>
          )}
        </div>
      ) : (
        <form
          className="application-reject"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason) {
              setError('Choose a reason for rejecting.');
              return;
            }
            void move('REJECTED');
          }}
        >
          <label className="form-field">
            Reason
            <span className="select-control">
              <select
                value={reason}
                onChange={(event) =>
                  setReason(event.target.value as typeof reason)
                }
              >
                <option value="">Choose a reason</option>
                {Object.entries(rejectionReasons).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
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
          <label className="form-field">
            Note (optional)
            <textarea
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="application-decision-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {busy ? 'Rejecting…' : 'Reject application'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="application-decision-message">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ApplicationDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { seesScreening, canScreen } = useScreeningAccess();
  const [downloadError, setDownloadError] = useState('');
  const query = useQuery({
    queryKey: ['application-details', id],
    queryFn: () => api<Details>(`/applications/${id}/details`),
    retry: false,
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  const value = query.data;
  const details = value?.details;
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="job-dialog application-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              {value ? value.candidate.full_name : 'Application'}
            </h2>
            {value && (
              <p>
                {value.job.title} · Applied {date(value.created_at)} ·{' '}
                {sentence(value.stage)}
              </p>
            )}
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Close application"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        {query.isPending ? (
          <p role="status" className="job-dialog-text">
            Loading…
          </p>
        ) : query.isError || !value ? (
          <p className="form-error" role="alert">
            {query.error instanceof Error
              ? query.error.message
              : 'This application couldn’t be loaded.'}
          </p>
        ) : (
          <>
            {value.candidate.erased && (
              <p className="job-dialog-text">
                This candidate’s personal data was erased.
              </p>
            )}
            {seesScreening && !value.candidate.erased && (
              <ScreeningPanel
                applicationId={value.id}
                // Hiring managers can't see documents, but can read screenings.
                hasResume={
                  !canScreen ||
                  value.documents.some(
                    (document) => document.scan_status !== 'INFECTED',
                  )
                }
              />
            )}
            {!value.pay_and_contact_hidden && (
              <section className="application-section">
                <h3>Contact</h3>
                <dl>
                  <Item label="Email">
                    {value.candidate.email ? (
                      <a href={`mailto:${value.candidate.email}`}>
                        {value.candidate.email}
                      </a>
                    ) : (
                      '—'
                    )}
                  </Item>
                  <Item label="Phone">
                    {value.candidate.phone ? (
                      <a href={`tel:${value.candidate.phone}`}>
                        {value.candidate.phone}
                      </a>
                    ) : (
                      '—'
                    )}
                  </Item>
                </dl>
              </section>
            )}
            {!value.candidate.erased && (
              <section className="application-section">
                <h3>Interviews</h3>
                <ApplicationInterviews applicationId={value.id} />
              </section>
            )}
            {details ? (
              <>
                <section className="application-section">
                  <h3>Experience</h3>
                  <dl>
                    <Item label="Total experience">
                      {formatExperience(details.total_experience_months)}
                    </Item>
                    <Item label="Current or last role">
                      {[details.current_title, details.current_company]
                        .filter(Boolean)
                        .join(' at ') || '—'}
                    </Item>
                    <Item label="Notice period">
                      {noticePeriodLabels[details.notice_period]}
                      {details.last_working_day &&
                        ` · last day ${date(`${details.last_working_day}T00:00:00`)}`}
                    </Item>
                    <Item label="Current city">{details.current_location}</Item>
                    <Item label="Willing to relocate">
                      {details.willing_to_relocate === null
                        ? 'Not answered'
                        : details.willing_to_relocate
                          ? 'Yes'
                          : 'No'}
                    </Item>
                  </dl>
                </section>
                {!value.pay_and_contact_hidden && (
                  <section className="application-section">
                    <h3>Pay (annual CTC)</h3>
                    <dl>
                      <Item label="Current">
                        {details.current_ctc !== null && details.ctc_currency
                          ? formatPay(details.current_ctc, details.ctc_currency)
                          : 'Not given'}
                      </Item>
                      <Item label="Expected">
                        {details.expected_ctc !== null && details.ctc_currency
                          ? formatPay(
                              details.expected_ctc,
                              details.ctc_currency,
                            )
                          : '—'}
                      </Item>
                    </dl>
                  </section>
                )}
                <section className="application-section">
                  <h3>Profile</h3>
                  <dl>
                    <Item label="LinkedIn">
                      {details.linkedin_url ? (
                        <a
                          href={details.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {details.linkedin_url}
                        </a>
                      ) : (
                        '—'
                      )}
                    </Item>
                    <Item label="Portfolio or website">
                      {details.portfolio_url ? (
                        <a
                          href={details.portfolio_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {details.portfolio_url}
                        </a>
                      ) : (
                        '—'
                      )}
                    </Item>
                    <Item label="Heard about the job">
                      {sourceLabels[details.source]}
                      {details.referrer && ` · referred by ${details.referrer}`}
                    </Item>
                  </dl>
                  {details.cover_letter && (
                    <>
                      <h4>Why they’re interested</h4>
                      <p className="application-letter">
                        {details.cover_letter}
                      </p>
                    </>
                  )}
                </section>
              </>
            ) : (
              <p className="job-dialog-text">
                This application was added without apply form details.
              </p>
            )}
            {value.pay_and_contact_hidden && (
              <p className="channel-hint">
                Pay, contact details and the resume are shown to HR admins,
                recruiters and hiring managers.
              </p>
            )}
            {value.documents.length > 0 && (
              <section className="application-section">
                <h3>Resume</h3>
                <ul className="application-documents">
                  {value.documents.map((document) => (
                    <li key={document.id}>
                      <span>
                        {document.original_name}
                        <small>
                          {document.scan_status === 'CLEAN'
                            ? `Uploaded ${date(document.created_at)}`
                            : document.scan_status === 'PENDING'
                              ? 'Waiting for the virus scan'
                              : 'Blocked by the virus scan'}
                        </small>
                      </span>
                      <button
                        type="button"
                        disabled={document.scan_status !== 'CLEAN'}
                        onClick={() => {
                          setDownloadError('');
                          downloadResume(value.candidate.id, document).catch(
                            (reason: Error) => setDownloadError(reason.message),
                          );
                        }}
                      >
                        <FontAwesomeIcon icon={faDownload} aria-hidden="true" />{' '}
                        Download
                      </button>
                    </li>
                  ))}
                </ul>
                {value.documents[0].sent_with === 'another_application' ? (
                  <p className="channel-hint">
                    No resume came with this application, so this is the one the
                    candidate sent with another application.
                  </p>
                ) : value.other_resumes ? (
                  <p className="channel-hint">
                    The resume sent with this application, which screening uses.
                    The candidate has{' '}
                    {plural(value.other_resumes, 'other resume')}, from other
                    applications or uploads.
                  </p>
                ) : null}
                {downloadError && (
                  <p className="form-error" role="alert">
                    {downloadError}
                  </p>
                )}
              </section>
            )}
            {canScreen && !value.candidate.erased && (
              <CallPanel applicationId={value.id} />
            )}
            <DecisionPanel value={value} />
          </>
        )}
      </div>
    </div>
  );
}
