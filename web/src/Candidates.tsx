import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleCheck,
  faEllipsis,
  faEnvelope,
  faFilter,
  faLocationDot,
  faMagnifyingGlass,
  faPhone,
  faPlus,
  faTriangleExclamation,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api, ApiError } from './api';
import { CallPanel } from './Calls';
import {
  downloadResume,
  fitLabels,
  rejectionReasonLabels,
  ScreeningPanel,
  type Details,
  type Fit,
  type Screening,
  type ScreeningStatus,
} from './Applications';
import { formatExperience, formatPay, noticePeriodLabels } from './Careers';
import { ApplicationInterviews, InterviewForm } from './Interviews';

type Stage =
  'APPLIED' | 'SHORTLISTED' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
type Row = {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: Stage;
  created_at: string;
  job_title: string;
  candidate_name: string;
  candidate_email: string | null;
  current_title: string | null;
  total_experience_months: number | null;
  screening_status: ScreeningStatus | null;
  screening_score: number | null;
  screening_fit: Fit | null;
  /** The latest AI call: its status and how it ended. */
  call_status:
    'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | null;
  call_outcome:
    'COMPLETED' | 'DECLINED' | 'WRONG_PERSON' | 'UNREACHED' | 'FAILED' | null;
  /** A call got through the questions (this one or an earlier one). */
  call_completed: boolean | null;
  /** When a planned call will be made, and whether the candidate asked for it. */
  call_next_at?: string | null;
  call_back?: boolean | null;
  /** That call's assessment and score. */
  call_assessment_status: 'PENDING' | 'COMPLETED' | 'FAILED' | null;
  call_score: number | null;
  call_fit: Fit | null;
};
type ListPage = {
  data: Row[];
  total: number;
  stage_counts?: Partial<Record<Stage, number>>;
};
type StageEvent = {
  id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  reason_code: keyof typeof rejectionReasonLabels | null;
  note: string | null;
  created_at: string;
};
type Job = { id: string; title: string; status: string };

/** The page lists candidates from shortlisted onward. */
const PIPELINE: Stage[] = ['SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED'];
const tabs: { stage: Stage | ''; label: string }[] = [
  { stage: '', label: 'All Candidates' },
  { stage: 'SHORTLISTED', label: 'Shortlisted' },
  { stage: 'INTERVIEW', label: 'In Interview' },
  { stage: 'OFFER', label: 'Offered' },
  { stage: 'HIRED', label: 'Hired' },
];
const stageLabels: Record<Stage, string> = {
  APPLIED: 'Applied',
  SHORTLISTED: 'Shortlisted',
  INTERVIEW: 'In Interview',
  OFFER: 'Offered',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
};
const PAGE_SIZE = 10;
/** Stages an interview can be scheduled from. */
const schedulable = (stage: Stage) =>
  stage === 'SHORTLISTED' || stage === 'INTERVIEW';
const rejectable = schedulable;
/** Why interviews wait, while AI calling is on and no call was completed. */
const CALL_FIRST = 'Available once the candidate completes an AI call.';
/** A call is being placed or assessed: the list refreshes to show it. */
const callActive = (row: Row) =>
  row.call_status === 'PLANNED' ||
  row.call_status === 'IN_PROGRESS' ||
  row.call_assessment_status === 'PENDING';

const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
const dateTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? '') + (words.length > 1 ? words.at(-1)![0] : '')
  ).toUpperCase();
}
/** A soft colour per name, so avatars stay the same between visits. */
function tone(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}
function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span
      className={`cand-avatar cand-avatar-${tone(name)}${large ? ' cand-avatar-large' : ''}`}
      aria-hidden="true"
    >
      {initials(name) || '?'}
    </span>
  );
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span className={`cand-stage cand-stage-${stage.toLowerCase()}`}>
      {stageLabels[stage]}
    </span>
  );
}

function ScoreCell({ row }: { row: Row }) {
  if (row.screening_status === 'COMPLETED' && row.screening_fit)
    return (
      <span
        className={`cand-score cand-score-${row.screening_fit.toLowerCase()}`}
        title={fitLabels[row.screening_fit]}
      >
        {row.screening_score}%
      </span>
    );
  if (row.screening_status === 'QUEUED' || row.screening_status === 'RUNNING')
    return <span className="cand-muted">Screening…</span>;
  if (row.screening_status === 'FAILED')
    return <span className="cand-muted">Failed</span>;
  return <span className="cand-muted">—</span>;
}

const callLabels: Record<string, string> = {
  COMPLETED: 'Completed',
  PLANNED: 'Scheduled',
  IN_PROGRESS: 'Calling…',
  CANCELLED: 'Cancelled',
  DECLINED: 'Declined',
  WRONG_PERSON: 'Wrong number',
  UNREACHED: 'Unreached',
  FAILED: 'Failed',
};

/** "Today, 2:00 PM", "Tomorrow, 9:00 AM" or "28 Nov, 2:00 PM". */
function shortWhen(value: string) {
  const at = new Date(value);
  const time = new Intl.DateTimeFormat(undefined, {
    timeStyle: 'short',
  }).format(at);
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toDateString();
  };
  if (at.toDateString() === day(0)) return `Today, ${time}`;
  if (at.toDateString() === day(1)) return `Tomorrow, ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at)}, ${time}`;
}

/** Whether the AI call was completed, and its score. */
function CallCell({ row }: { row: Row }) {
  const pending =
    row.call_status === 'PLANNED' || row.call_status === 'IN_PROGRESS';
  if (row.call_completed)
    return (
      <span className="cand-call">
        <span className="cand-call-status done">
          <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
          Completed
        </span>
        {row.call_score !== null && row.call_fit ? (
          <span
            className={`cand-score cand-score-${row.call_fit.toLowerCase()}`}
            title={`Call score: ${fitLabels[row.call_fit]}`}
          >
            {row.call_score}%
          </span>
        ) : (
          <small className="cand-muted">
            {row.call_assessment_status === 'PENDING'
              ? 'Scoring…'
              : 'Not scored'}
          </small>
        )}
      </span>
    );
  const status = pending
    ? callLabels[row.call_status!]
    : row.call_outcome
      ? callLabels[row.call_outcome]
      : row.call_status
        ? callLabels[row.call_status]
        : null;
  return (
    <span className="cand-call">
      <span className={`cand-call-status${pending ? ' pending' : ''}`}>
        {row.call_status === 'PLANNED' && row.call_back
          ? 'Call back'
          : (status ?? 'Not called')}
      </span>
      {row.call_status === 'PLANNED' && row.call_next_at ? (
        <small className="cand-muted">{shortWhen(row.call_next_at)}</small>
      ) : (
        !pending && <small className="cand-muted">Not completed</small>
      )}
    </span>
  );
}

/** A small menu that closes on Escape or a click elsewhere. */
function Menu({
  label,
  button,
  className = '',
  items,
}: {
  label: string;
  button: ReactNode;
  className?: string;
  items: {
    text: string;
    onSelect: () => void;
    disabled?: boolean;
    /** Shown under the item while it's disabled: why. */
    hint?: string;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div
      className="cand-menu"
      ref={box}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {button}
      </button>
      {open && (
        <ul className="cand-menu-list" role="menu">
          {items.map((item) => (
            <li key={item.text} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.text}
                {item.disabled && item.hint && <small>{item.hint}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Page numbers around the current one, with gaps: 1 … 4 5 6 … 20. */
function pages(current: number, count: number): (number | '…')[] {
  const shown = new Set(
    [1, count, current - 1, current, current + 1].filter(
      (page) => page >= 1 && page <= count,
    ),
  );
  const sorted = [...shown].sort((a, b) => a - b);
  return sorted.flatMap((page, index) =>
    index && page - sorted[index - 1] > 1 ? ['…' as const, page] : [page],
  );
}

/** Moves applications, one at a time, and says how many moved. */
async function moveMany(
  ids: string[],
  body: Record<string, unknown>,
): Promise<{ moved: number; failed: string[] }> {
  let moved = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await api(`/applications/${id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      moved++;
    } catch (error) {
      failed.push(message(error, 'Couldn’t be moved.'));
    }
  }
  return { moved, failed };
}

export function CandidatesPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Stage | ''>('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [jobId, setJobId] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<'created_at' | 'score'>('created_at');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [scheduling, setScheduling] = useState<Row | null>(null);
  const [rejecting, setRejecting] = useState<Row[] | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('overview');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState('');

  // Search as the recruiter types, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchText]);
  // A different list: start again from the first page, with nothing ticked.
  useEffect(
    () => setChecked(new Set()),
    [tab, search, jobId, aiResult, from, to, sort, offset],
  );

  const params = new URLSearchParams({
    stages: PIPELINE.join(','),
    counts: 'true',
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (tab) params.set('stage', tab);
  if (search) params.set('q', search);
  if (jobId) params.set('jobId', jobId);
  if (aiResult === 'not_screened') params.set('screening', 'not_screened');
  else if (aiResult) params.set('fit', aiResult);
  if (from)
    params.set('createdFrom', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('createdTo', new Date(`${to}T23:59:59.999`).toISOString());
  if (sort === 'score') params.set('sort', 'score');
  const list = useQuery({
    queryKey: ['candidates', params.toString()],
    queryFn: () => api<ListPage>(`/applications?${params.toString()}`),
    retry: false,
    placeholderData: (previous) => previous,
    // Calls finish in the background: refresh to show them.
    refetchInterval: (query) =>
      query.state.data?.data.some(callActive) ? 10_000 : 30_000,
  });
  // While AI calling is on, interviews wait for a completed call.
  const calling = useQuery({
    queryKey: ['call-questions-settings'],
    queryFn: () =>
      api<{ enabled: boolean; ai_available: boolean }>(
        '/jobs/call-questions/settings',
      ),
    retry: false,
  });
  const callGate = calling.data?.enabled ?? true;
  const canAdvance = (row: Row) => !callGate || !!row.call_completed;
  const jobs = useQuery({
    queryKey: ['applications-jobs'],
    queryFn: () =>
      api<{ data: Job[] }>('/jobs?limit=100&sort=updated_at&direction=desc'),
    retry: false,
  });

  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const counts = list.data?.stage_counts ?? {};
  const allCount = PIPELINE.reduce(
    (sum, stage) => sum + (counts[stage] ?? 0),
    0,
  );
  const current = rows.some((row) => row.id === selected)
    ? selected
    : (rows[0]?.id ?? null);
  const currentRow = rows.find((row) => row.id === current) ?? null;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const ticked = rows.filter((row) => checked.has(row.id));
  const extraFilters = [from, to, sort === 'score' ? 'sort' : ''].filter(
    Boolean,
  ).length;

  async function refresh(...ids: string[]) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      queryClient.invalidateQueries({ queryKey: ['applications'] }),
      ...ids.flatMap((id) => [
        queryClient.invalidateQueries({
          queryKey: ['application-details', id],
        }),
        queryClient.invalidateQueries({ queryKey: ['candidate-history', id] }),
      ]),
    ]);
  }

  function say(text: string, error = '') {
    setNotice(text);
    setNoticeError(error);
  }

  async function toInterview(targets: Row[]) {
    const shortlisted = targets.filter((row) => row.stage === 'SHORTLISTED');
    const eligible = shortlisted.filter(canAdvance);
    const waiting = shortlisted.length - eligible.length;
    if (!eligible.length) {
      say(
        '',
        shortlisted.length
          ? 'Only candidates who completed an AI call can move to In Interview.'
          : 'Only shortlisted candidates can move to In Interview.',
      );
      return;
    }
    const result = await moveMany(
      eligible.map((row) => row.id),
      { stage: 'INTERVIEW' },
    );
    await refresh(...eligible.map((row) => row.id));
    say(
      result.moved
        ? `Moved ${plural(result.moved, 'candidate')} to In Interview.${
            waiting
              ? ` ${plural(waiting, 'candidate')} without a completed AI call stayed shortlisted.`
              : ''
          }`
        : '',
      result.failed.length
        ? `${plural(result.failed.length, 'candidate')} couldn’t be moved: ${result.failed[0]}`
        : '',
    );
  }

  async function callMany(targets: Row[]) {
    const eligible = targets.filter((row) => schedulable(row.stage));
    let planned = 0;
    const failed: string[] = [];
    for (const row of eligible) {
      try {
        await api('/call-requests', {
          method: 'POST',
          body: JSON.stringify({
            applicationId: row.id,
            language: 'EN',
            recording: false,
            transcription: false,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        planned++;
      } catch (error) {
        failed.push(`${row.candidate_name}: ${message(error, 'not called')}`);
      }
    }
    await Promise.all(
      eligible.map((row) =>
        queryClient.invalidateQueries({
          queryKey: ['application-calls', row.id],
        }),
      ),
    );
    say(
      planned
        ? `The AI will call ${plural(planned, 'candidate')} during calling hours. Answers appear in Call Summary.`
        : '',
      failed.length
        ? `${plural(failed.length, 'candidate')} can’t be called. ${failed[0]}`
        : eligible.length
          ? ''
          : 'Only shortlisted or interviewing candidates can be called.',
    );
  }

  function toggleAll(on: boolean) {
    setChecked(on ? new Set(rows.map((row) => row.id)) : new Set());
  }

  const titleId = useId();
  return (
    <section className="cand-page" aria-labelledby={titleId}>
      <header className="cand-heading">
        <div>
          <h1 id={titleId}>Candidates</h1>
          <p className="intro">
            View, filter and manage candidates from shortlisting to hiring.
          </p>
        </div>
        <div className="cand-heading-actions">
          <button
            type="button"
            className="cand-add"
            onClick={() => setAdding(true)}
          >
            <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Add Candidate
          </button>
          <Menu
            label={
              ticked.length
                ? `Bulk actions for ${plural(ticked.length, 'candidate')}`
                : 'Bulk actions: tick candidates first'
            }
            className="cand-bulk"
            button={
              <>
                Bulk Actions
                {ticked.length > 0 && (
                  <span className="cand-count">{ticked.length}</span>
                )}
                <FontAwesomeIcon icon={faChevronDown} aria-hidden="true" />
              </>
            }
            items={[
              {
                text: 'Move to In Interview',
                disabled: !ticked.some(
                  (row) => row.stage === 'SHORTLISTED' && canAdvance(row),
                ),
                hint: ticked.some((row) => row.stage === 'SHORTLISTED')
                  ? 'For candidates who completed an AI call.'
                  : undefined,
                onSelect: () => void toInterview(ticked),
              },
              {
                text: 'Call with AI',
                disabled: !ticked.some((row) => schedulable(row.stage)),
                onSelect: () => void callMany(ticked),
              },
              {
                text: 'Reject…',
                disabled: !ticked.some((row) => rejectable(row.stage)),
                onSelect: () =>
                  setRejecting(ticked.filter((row) => rejectable(row.stage))),
              },
            ]}
          />
        </div>
      </header>

      {(notice || noticeError) && (
        <div className="cand-notice">
          {notice && (
            <p role="status" className="form-success">
              {notice}
            </p>
          )}
          {noticeError && (
            <p role="alert" className="form-error">
              {noticeError}
            </p>
          )}
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Dismiss"
            onClick={() => say('')}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="cand-layout">
        <section className="cand-list" aria-label="Candidate list">
          <div className="cand-tabs" role="tablist" aria-label="Stages">
            {tabs.map((item) => (
              <button
                key={item.label}
                type="button"
                role="tab"
                aria-selected={tab === item.stage}
                className={tab === item.stage ? 'active' : undefined}
                onClick={() => {
                  setTab(item.stage);
                  setOffset(0);
                }}
              >
                {item.label}{' '}
                <span>
                  ({item.stage ? (counts[item.stage] ?? 0) : allCount})
                </span>
              </button>
            ))}
          </div>

          <form
            className="cand-filters"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setSearch(searchText.trim());
              setOffset(0);
            }}
          >
            <label className="cand-search">
              <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
              <span className="sr-only">Search candidates</span>
              <input
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search by name or email…"
              />
            </label>
            <FilterSelect
              label="Filter by job"
              value={jobId}
              onChange={(value) => {
                setJobId(value);
                setOffset(0);
              }}
              options={[
                ['', 'All Jobs'],
                ...(jobs.data?.data ?? []).map(
                  (job) => [job.id, job.title] as [string, string],
                ),
              ]}
            />
            <FilterSelect
              label="Filter by AI result"
              value={aiResult}
              onChange={(value) => {
                setAiResult(value);
                setOffset(0);
              }}
              options={[
                ['', 'All AI Results'],
                ...(Object.keys(fitLabels) as Fit[]).map(
                  (fit) => [fit, fitLabels[fit]] as [string, string],
                ),
                ['not_screened', 'Not screened'],
              ]}
            />
            <button
              type="button"
              className="cand-more"
              aria-expanded={moreFilters}
              onClick={() => setMoreFilters(!moreFilters)}
            >
              <FontAwesomeIcon icon={faFilter} aria-hidden="true" /> More
              Filters
              {extraFilters > 0 && (
                <span className="cand-count">{extraFilters}</span>
              )}
            </button>
            {moreFilters && (
              <div className="cand-more-filters">
                <label>
                  Applied from
                  <input
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(event) => {
                      setFrom(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label>
                  Applied to
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(event) => {
                      setTo(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <FilterSelect
                  label="Sort"
                  visibleLabel
                  value={sort}
                  onChange={(value) => {
                    setSort(value as 'created_at' | 'score');
                    setOffset(0);
                  }}
                  options={[
                    ['created_at', 'Newest first'],
                    ['score', 'Best AI score first'],
                  ]}
                />
                {extraFilters > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setFrom('');
                      setTo('');
                      setSort('created_at');
                      setOffset(0);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </form>

          {list.isError ? (
            <p role="alert" className="form-error cand-state">
              {message(list.error, 'Candidates couldn’t be loaded.')}{' '}
              <button type="button" onClick={() => void list.refetch()}>
                Retry
              </button>
            </p>
          ) : (
            <div className="cand-table-scroll">
              <table className="cand-table">
                <thead>
                  <tr>
                    <th scope="col" className="cand-check">
                      <input
                        type="checkbox"
                        aria-label="Select all candidates on this page"
                        checked={
                          rows.length > 0 &&
                          rows.every((r) => checked.has(r.id))
                        }
                        onChange={(event) => toggleAll(event.target.checked)}
                      />
                    </th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Job Title</th>
                    <th scope="col">Experience</th>
                    <th scope="col">AI Score</th>
                    <th scope="col">AI Call</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Applied On</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                      <span aria-hidden="true">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.isPending ? (
                    <tr>
                      <td colSpan={9} className="cand-state" role="status">
                        Loading candidates…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="cand-state">
                        {search || jobId || aiResult || extraFilters
                          ? 'No candidates match these filters.'
                          : tab
                            ? `No candidates are ${stageLabels[tab].toLowerCase()} yet.`
                            : 'No shortlisted candidates yet. Shortlist applicants on the Applications page, or add a candidate.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className={row.id === current ? 'selected' : undefined}
                        onClick={() => setSelected(row.id)}
                      >
                        <td className="cand-check">
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.candidate_name}`}
                            checked={checked.has(row.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              const next = new Set(checked);
                              if (event.target.checked) next.add(row.id);
                              else next.delete(row.id);
                              setChecked(next);
                            }}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="cand-person"
                            aria-label={`View ${row.candidate_name}`}
                            aria-current={row.id === current || undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelected(row.id);
                              setPanelTab('overview');
                            }}
                          >
                            <Avatar name={row.candidate_name} />
                            <span>
                              <strong>{row.candidate_name}</strong>
                              {row.candidate_email && (
                                <small>{row.candidate_email}</small>
                              )}
                            </span>
                          </button>
                        </td>
                        <td>{row.job_title}</td>
                        <td>{formatExperience(row.total_experience_months)}</td>
                        <td>
                          <ScoreCell row={row} />
                        </td>
                        <td>
                          <CallCell row={row} />
                        </td>
                        <td>
                          <StagePill stage={row.stage} />
                        </td>
                        <td>{date(row.created_at)}</td>
                        <td>
                          <Menu
                            label={`Actions for ${row.candidate_name}`}
                            className="cand-icon-button"
                            button={
                              <FontAwesomeIcon
                                icon={faEllipsis}
                                aria-hidden="true"
                              />
                            }
                            items={[
                              {
                                text: 'View details',
                                onSelect: () => {
                                  setSelected(row.id);
                                  setPanelTab('overview');
                                },
                              },
                              {
                                text: 'Schedule interview',
                                disabled:
                                  !schedulable(row.stage) || !canAdvance(row),
                                hint: schedulable(row.stage)
                                  ? CALL_FIRST
                                  : undefined,
                                onSelect: () => setScheduling(row),
                              },
                              {
                                text: 'Move to In Interview',
                                disabled:
                                  row.stage !== 'SHORTLISTED' ||
                                  !canAdvance(row),
                                hint:
                                  row.stage === 'SHORTLISTED'
                                    ? CALL_FIRST
                                    : undefined,
                                onSelect: () => void toInterview([row]),
                              },
                              {
                                text: 'Reject…',
                                disabled: !rejectable(row.stage),
                                onSelect: () => setRejecting([row]),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          <footer className="cand-pager">
            <p>
              {total
                ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${plural(total, 'candidate')}`
                : 'No candidates'}
            </p>
            {pageCount > 1 && (
              <nav aria-label="Pages">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() => setOffset(offset - PAGE_SIZE)}
                >
                  <FontAwesomeIcon icon={faChevronLeft} aria-hidden="true" />
                </button>
                {pages(page, pageCount).map((item, index) =>
                  item === '…' ? (
                    <span key={`gap-${index}`} aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      aria-label={`Page ${item}`}
                      aria-current={item === page ? 'page' : undefined}
                      className={item === page ? 'active' : undefined}
                      onClick={() => setOffset((item - 1) * PAGE_SIZE)}
                    >
                      {item}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={page === pageCount}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  <FontAwesomeIcon icon={faChevronRight} aria-hidden="true" />
                </button>
              </nav>
            )}
          </footer>
        </section>

        {currentRow ? (
          <CandidatePanel
            key={currentRow.id}
            row={currentRow}
            callDone={canAdvance(currentRow)}
            tab={panelTab}
            onTab={setPanelTab}
            onSchedule={() => setScheduling(currentRow)}
            onReject={() => setRejecting([currentRow])}
            onMoved={async (text) => {
              await refresh(currentRow.id);
              say(text);
            }}
            onNotice={say}
          />
        ) : (
          <section className="cand-panel cand-panel-empty">
            <p>
              {list.isPending
                ? 'Loading…'
                : 'Select a candidate to see their details.'}
            </p>
          </section>
        )}
      </div>

      {adding && (
        <AddCandidateDialog
          jobs={(jobs.data?.data ?? []).filter(
            (job) => job.status === 'PUBLISHED',
          )}
          onClose={() => setAdding(false)}
          onAdded={async (applicationId, text) => {
            setAdding(false);
            setTab('');
            setOffset(0);
            setSelected(applicationId);
            await refresh(applicationId);
            say(text);
          }}
        />
      )}
      {scheduling && (
        <InterviewForm
          application={{
            id: scheduling.id,
            candidateName: scheduling.candidate_name,
            jobTitle: scheduling.job_title,
            stage: scheduling.stage,
          }}
          onClose={() => setScheduling(null)}
          onSaved={async (text, problem) => {
            const id = scheduling.id;
            setScheduling(null);
            await Promise.all([
              refresh(id),
              queryClient.invalidateQueries({ queryKey: ['interviews'] }),
            ]);
            say(text, problem);
          }}
        />
      )}
      {rejecting && (
        <RejectDialog
          rows={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={async (text, error) => {
            const ids = rejecting.map((row) => row.id);
            setRejecting(null);
            await refresh(...ids);
            say(text, error);
          }}
        />
      )}
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  visibleLabel = false,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  visibleLabel?: boolean;
}) {
  return (
    <label className="cand-select">
      <span className={visibleLabel ? undefined : 'sr-only'}>{label}</span>
      <span className="select-control">
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map(([id, text]) => (
            <option key={id} value={id}>
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

type PanelTab =
  'overview' | 'resume' | 'screening' | 'calls' | 'interviews' | 'history';
const panelTabs: { id: PanelTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'resume', label: 'Resume' },
  { id: 'screening', label: 'AI Screening' },
  { id: 'calls', label: 'Call Summary' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'history', label: 'History' },
];

function CandidatePanel({
  row,
  callDone,
  tab,
  onTab,
  onSchedule,
  onReject,
  onMoved,
  onNotice,
}: {
  row: Row;
  /** A completed AI call, or no call needed: interviews may go ahead. */
  callDone: boolean;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onSchedule: () => void;
  onReject: () => void;
  onMoved: (message: string) => Promise<void>;
  onNotice: (message: string, problem: string) => void;
}) {
  const nameId = useId();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['application-details', row.id],
    queryFn: () => api<Details>(`/applications/${row.id}/details`),
    retry: false,
  });
  const screening = useQuery({
    queryKey: ['application-screening', row.id],
    queryFn: () =>
      api<{ screening: Screening | null }>(`/applications/${row.id}/screening`),
    retry: false,
  });
  const value = query.data;
  const details = value?.details;
  const stage = (value?.stage as Stage | undefined) ?? row.stage;
  const resume = value?.documents[0];

  async function toInterview() {
    setMoving(true);
    setError('');
    try {
      await api(`/applications/${row.id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'INTERVIEW' }),
      });
      await onMoved(`${row.candidate_name} moved to In Interview.`);
    } catch (reason) {
      setError(message(reason, 'The stage couldn’t be changed.'));
    } finally {
      setMoving(false);
    }
  }

  return (
    <section className="cand-panel" aria-labelledby={nameId}>
      <header className="cand-panel-head">
        <Avatar name={row.candidate_name} large />
        <div className="cand-panel-who">
          <div className="cand-panel-title">
            <h2 id={nameId}>{row.candidate_name}</h2>
            <StagePill stage={stage} />
            <Menu
              label={`More for ${row.candidate_name}`}
              className="cand-icon-button"
              button={<FontAwesomeIcon icon={faEllipsis} aria-hidden="true" />}
              items={[
                {
                  text: 'Download resume',
                  disabled: !resume || !value,
                  onSelect: () => {
                    if (resume && value)
                      downloadResume(value.candidate.id, resume).catch(
                        (reason: unknown) =>
                          setError(
                            message(
                              reason,
                              'The resume couldn’t be downloaded.',
                            ),
                          ),
                      );
                  },
                },
                {
                  text: 'Reject…',
                  disabled: !rejectable(stage),
                  onSelect: onReject,
                },
              ]}
            />
          </div>
          <p className="cand-panel-sub">
            {row.job_title} <span aria-hidden="true">•</span> Applied on{' '}
            {date(row.created_at)}
          </p>
          {value && !value.candidate.erased && (
            <ul className="cand-contact">
              {value.candidate.email && (
                <li>
                  <FontAwesomeIcon icon={faEnvelope} aria-hidden="true" />
                  <a href={`mailto:${value.candidate.email}`}>
                    {value.candidate.email}
                  </a>
                </li>
              )}
              {value.candidate.phone && (
                <li>
                  <FontAwesomeIcon icon={faPhone} aria-hidden="true" />
                  <a href={`tel:${value.candidate.phone}`}>
                    {value.candidate.phone}
                  </a>
                </li>
              )}
              {details?.current_location && (
                <li>
                  <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" />
                  {details.current_location}
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="cand-panel-actions">
          <button
            type="button"
            className="button-primary"
            disabled={!schedulable(stage) || !callDone}
            title={
              !schedulable(stage)
                ? 'Interviews are scheduled for shortlisted or interviewing candidates.'
                : callDone
                  ? undefined
                  : CALL_FIRST
            }
            onClick={onSchedule}
          >
            Schedule Interview
          </button>
          <Menu
            label="Move to stage"
            className="cand-move"
            button={
              <>
                {moving ? 'Moving…' : 'Move to Stage'}
                <FontAwesomeIcon icon={faChevronDown} aria-hidden="true" />
              </>
            }
            items={[
              {
                text: 'In Interview',
                disabled: stage !== 'SHORTLISTED' || moving || !callDone,
                hint: stage === 'SHORTLISTED' ? CALL_FIRST : undefined,
                onSelect: () => void toInterview(),
              },
              {
                text: 'Rejected…',
                disabled: !rejectable(stage) || moving,
                onSelect: onReject,
              },
            ]}
          />
          {(stage === 'OFFER' || stage === 'HIRED') && (
            <small className="cand-muted">Offers set this stage.</small>
          )}
          {schedulable(stage) && !callDone && (
            <button
              type="button"
              className="text-button cand-call-first"
              onClick={() => onTab('calls')}
            >
              Needs a completed AI call. Call now
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="form-error cand-panel-error">
          {error}
        </p>
      )}

      <div className="cand-panel-tabs" role="tablist" aria-label="Candidate">
        {panelTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : undefined}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="cand-panel-body" role="tabpanel">
        {query.isPending ? (
          <p role="status" className="cand-state">
            Loading…
          </p>
        ) : query.isError || !value ? (
          <p role="alert" className="form-error">
            {message(query.error, 'This candidate couldn’t be loaded.')}
          </p>
        ) : value.candidate.erased ? (
          <p className="cand-state">
            This candidate’s personal data was erased.
          </p>
        ) : tab === 'overview' ? (
          <Overview
            value={value}
            screening={screening.data?.screening ?? null}
            screeningLoading={screening.isPending}
            onScreening={() => onTab('screening')}
          />
        ) : tab === 'resume' ? (
          <ResumeTab value={value} />
        ) : tab === 'screening' ? (
          <ScreeningPanel applicationId={row.id} hasResume={!!resume} />
        ) : tab === 'calls' ? (
          <CallPanel applicationId={row.id} />
        ) : tab === 'interviews' ? (
          <ApplicationInterviews applicationId={row.id} onNotice={onNotice} />
        ) : (
          <HistoryTab applicationId={row.id} />
        )}
      </div>
    </section>
  );
}

function Overview({
  value,
  screening,
  screeningLoading,
  onScreening,
}: {
  value: Details;
  screening: Screening | null;
  screeningLoading: boolean;
  onScreening: () => void;
}) {
  const details = value.details;
  const pay = (amount: number | null | undefined) =>
    amount === null || amount === undefined
      ? value.pay_and_contact_hidden
        ? 'Hidden'
        : '—'
      : formatPay(amount, details?.ctc_currency ?? 'INR');
  const result = screening?.status === 'COMPLETED' ? screening.result : null;
  const skills = result?.skills ?? [];
  const facts: [string, string][] = [
    ['Total Experience', formatExperience(details?.total_experience_months)],
    [
      'Current Role',
      [details?.current_title, details?.current_company]
        .filter(Boolean)
        .join(', ') || '—',
    ],
    ['Current CTC', pay(details?.current_ctc)],
    ['Expected CTC', pay(details?.expected_ctc)],
    [
      'Notice Period',
      details?.notice_period ? noticePeriodLabels[details.notice_period] : '—',
    ],
    [
      'Open to Relocate',
      details?.willing_to_relocate === null ||
      details?.willing_to_relocate === undefined
        ? '—'
        : details.willing_to_relocate
          ? 'Yes'
          : 'No',
    ],
  ];
  return (
    <div className="cand-overview">
      <section className="cand-card">
        <h3>Key Information</h3>
        {details ? (
          <dl className="cand-facts">
            {facts.map(([label, text]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="cand-muted">
            Added by staff, so there are no application answers.
          </p>
        )}
      </section>
      <section className="cand-card">
        <h3>
          Skills <small>(Extracted)</small>
        </h3>
        {skills.length ? (
          <ul className="cand-skills">
            {skills.map((skill) => (
              <li key={skill}>{skill}</li>
            ))}
          </ul>
        ) : (
          <p className="cand-muted">
            {screeningLoading
              ? 'Loading…'
              : result
                ? 'This screening is from before skills were extracted. Screen again to see them.'
                : 'Skills appear once the AI has screened the resume.'}{' '}
            {!screeningLoading && (
              <button
                type="button"
                className="text-button"
                onClick={onScreening}
              >
                Open AI Screening
              </button>
            )}
          </p>
        )}
      </section>
      <section className="cand-card cand-insights">
        <h3>
          <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden="true" /> AI
          Insights
        </h3>
        {result && screening?.fit ? (
          <>
            <ul className="cand-insight-list">
              <li
                className={
                  screening.fit === 'STRONG' || screening.fit === 'GOOD'
                    ? 'good'
                    : 'warn'
                }
              >
                <FontAwesomeIcon
                  icon={
                    screening.fit === 'STRONG' || screening.fit === 'GOOD'
                      ? faCircleCheck
                      : faTriangleExclamation
                  }
                  aria-hidden="true"
                />
                {fitLabels[screening.fit]} for the role ({screening.score}%)
              </li>
              {screening.missing_must_have && (
                <li className="warn">
                  <FontAwesomeIcon
                    icon={faTriangleExclamation}
                    aria-hidden="true"
                  />
                  Missing a must-have requirement
                </li>
              )}
              {result.strengths.slice(0, 3).map((point) => (
                <li key={point} className="good">
                  <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
                  {point}
                </li>
              ))}
              {result.concerns.slice(0, 2).map((point) => (
                <li key={point} className="warn">
                  <FontAwesomeIcon
                    icon={faTriangleExclamation}
                    aria-hidden="true"
                  />
                  {point}
                </li>
              ))}
            </ul>
            <p className="cand-note">AI suggestions only: you decide.</p>
          </>
        ) : (
          <p className="cand-muted">
            {screeningLoading
              ? 'Loading…'
              : screening?.status === 'QUEUED' ||
                  screening?.status === 'RUNNING'
                ? 'The AI is screening the resume…'
                : screening?.status === 'FAILED'
                  ? (screening.failure_message ?? 'The AI screening failed.')
                  : 'Not screened yet.'}{' '}
            {!screeningLoading && (
              <button
                type="button"
                className="text-button"
                onClick={onScreening}
              >
                Open AI Screening
              </button>
            )}
          </p>
        )}
      </section>
    </div>
  );
}

function ResumeTab({ value }: { value: Details }) {
  const [error, setError] = useState('');
  const resume = value.documents[0];
  const details = value.details;
  return (
    <div className="cand-resume">
      {resume ? (
        <section className="cand-card cand-file">
          <div>
            <h3>{resume.original_name}</h3>
            <p className="cand-muted">
              {Math.max(1, Math.round(resume.byte_size / 1024))} KB · Uploaded{' '}
              {date(resume.created_at)}
              {resume.scan_status !== 'CLEAN' &&
                ` · Virus scan: ${resume.scan_status.toLowerCase()}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError('');
              downloadResume(value.candidate.id, resume).catch(
                (reason: unknown) =>
                  setError(
                    message(reason, 'The resume couldn’t be downloaded.'),
                  ),
              );
            }}
          >
            Download
          </button>
        </section>
      ) : (
        <p className="cand-muted">No resume was sent with this application.</p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {(details?.linkedin_url || details?.portfolio_url) && (
        <ul className="cand-links">
          {details.linkedin_url && (
            <li>
              <a
                href={details.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                LinkedIn profile
              </a>
            </li>
          )}
          {details.portfolio_url && (
            <li>
              <a
                href={details.portfolio_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Portfolio
              </a>
            </li>
          )}
        </ul>
      )}
      {details?.cover_letter && (
        <section className="cand-card">
          <h3>Cover letter</h3>
          <p className="cand-cover">{details.cover_letter}</p>
        </section>
      )}
    </div>
  );
}

function HistoryTab({ applicationId }: { applicationId: string }) {
  const history = useQuery({
    queryKey: ['candidate-history', applicationId],
    queryFn: () => api<StageEvent[]>(`/applications/${applicationId}/history`),
    retry: false,
  });
  if (history.isPending)
    return (
      <p role="status" className="cand-state">
        Loading…
      </p>
    );
  if (history.isError)
    return (
      <p role="alert" className="form-error">
        {message(history.error, 'The history couldn’t be loaded.')}
      </p>
    );
  return (
    <div className="cand-history">
      <section className="cand-card">
        <h3>Stage history</h3>
        <ol className="cand-timeline">
          {[...(history.data ?? [])].reverse().map((event) => (
            <li key={event.id}>
              <strong>
                {event.from_stage
                  ? `${stageLabels[event.from_stage]} → ${stageLabels[event.to_stage]}`
                  : stageLabels[event.to_stage]}
              </strong>
              <span className="cand-muted">{dateTime(event.created_at)}</span>
              {event.reason_code && (
                <span>Reason: {rejectionReasonLabels[event.reason_code]}</span>
              )}
              {event.note && <span>{event.note}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** The dialog frame the other dialogs on this page use. */
function Dialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
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
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="job-dialog cand-dialog"
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

function RejectDialog({
  rows,
  onClose,
  onRejected,
}: {
  rows: Row[];
  onClose: () => void;
  onRejected: (message: string, error: string) => Promise<void>;
}) {
  const [reason, setReason] = useState<keyof typeof rejectionReasonLabels | ''>(
    '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason) {
      setError('Choose a reason.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await moveMany(
      rows.map((row) => row.id),
      {
        stage: 'REJECTED',
        reasonCode: reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    );
    setBusy(false);
    await onRejected(
      result.moved ? `Rejected ${plural(result.moved, 'candidate')}.` : '',
      result.failed.length
        ? `${plural(result.failed.length, 'candidate')} couldn’t be rejected: ${result.failed[0]}`
        : '',
    );
  }
  return (
    <Dialog
      title={
        rows.length === 1
          ? `Reject ${rows[0].candidate_name}?`
          : `Reject ${plural(rows.length, 'candidate')}?`
      }
      subtitle="They leave the hiring pipeline. The reason is kept in their history."
      onClose={onClose}
    >
      <form className="cand-form" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          Reason
          <span className="select-control">
            <select
              value={reason}
              required
              onChange={(event) =>
                setReason(
                  event.target.value as keyof typeof rejectionReasonLabels,
                )
              }
            >
              <option value="">Choose a reason</option>
              {Object.entries(rejectionReasonLabels).map(([id, text]) => (
                <option key={id} value={id}>
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
        <label className="form-field">
          Note (optional)
          <textarea
            value={note}
            maxLength={2000}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="cand-form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button-danger" disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AddCandidateDialog({
  jobs,
  onClose,
  onAdded,
}: {
  jobs: Job[];
  onClose: () => void;
  onAdded: (applicationId: string, message: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [jobId, setJobId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!jobId) {
      setError('Choose the job they’re a candidate for.');
      return;
    }
    setBusy(true);
    try {
      // The same person again (by email): add to their record.
      const found = await api<{ data: { id: string; email: string }[] }>(
        `/candidates?q=${encodeURIComponent(email.trim())}&limit=5`,
      );
      const existing = found.data.find(
        (c) => c.email.toLowerCase() === email.trim().toLowerCase(),
      );
      const candidateId =
        existing?.id ??
        (
          await api<{ id: string }>('/candidates', {
            method: 'POST',
            body: JSON.stringify({
              fullName: name.trim(),
              email: email.trim(),
              ...(phone.trim() ? { phone: phone.trim() } : {}),
            }),
          })
        ).id;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        const uploaded = await fetch(
          `/api/v1/candidates/${candidateId}/documents`,
          {
            method: 'POST',
            body: form,
            credentials: 'same-origin',
            cache: 'no-store',
          },
        ).catch(() => null);
        if (!uploaded?.ok) {
          const payload = await uploaded?.json().catch(() => null);
          throw new ApiError(
            uploaded?.status ?? 0,
            typeof payload?.message === 'string'
              ? `The resume couldn’t be uploaded: ${payload.message}`
              : 'The resume couldn’t be uploaded. Use a PDF or Word file up to 10 MB.',
          );
        }
      }
      const application = await api<{ id: string }>('/applications', {
        method: 'POST',
        body: JSON.stringify({ jobId, candidateId }),
      });
      // Added here: straight onto the shortlist.
      await api(`/applications/${application.id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'SHORTLISTED' }),
      });
      // With a resume, the AI screens it now; the panel shows its progress.
      if (file)
        void api(`/applications/${application.id}/screening`, {
          method: 'POST',
        })
          .catch(() => undefined)
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: ['candidates'] });
            void queryClient.invalidateQueries({
              queryKey: ['application-screening', application.id],
            });
          });
      await onAdded(
        application.id,
        `${name.trim()} was added to the shortlist${existing ? ' (an existing candidate with this email)' : ''}.`,
      );
    } catch (reason) {
      setError(message(reason, 'The candidate couldn’t be added.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Add candidate"
      subtitle="Adds them to a job’s shortlist, for example someone sourced or referred."
      onClose={onClose}
    >
      <form className="cand-form" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          Full name
          <input
            value={name}
            required
            minLength={2}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="cand-form-row">
          <label className="form-field">
            Email
            <input
              type="email"
              value={email}
              required
              maxLength={254}
              autoComplete="off"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="form-field">
            Phone (optional)
            <input
              type="tel"
              value={phone}
              placeholder="+919876543210"
              pattern="\+[1-9][0-9]{7,14}"
              title="With the country code, e.g. +919876543210"
              autoComplete="off"
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
        </div>
        <label className="form-field">
          Job
          <span className="select-control">
            <select
              value={jobId}
              required
              onChange={(event) => setJobId(event.target.value)}
            >
              <option value="">
                {jobs.length ? 'Choose a published job' : 'No published jobs'}
              </option>
              {jobs.map((job) => (
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
        <label className="form-field">
          Resume (optional)
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <small>A PDF or Word file, so the AI can screen it.</small>
        </label>
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
            {busy ? 'Adding…' : 'Add candidate'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
