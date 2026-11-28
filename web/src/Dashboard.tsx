import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRight,
  faBuilding,
  faBriefcase,
  faCalendarDays,
  faChartSimple,
  faChevronDown,
  faCircleCheck,
  faCircleMinus,
  faCircleQuestion,
  faFileLines,
  faHandshake,
  faEnvelope,
  faPhone,
  faPlus,
  faUsers,
  faVideo,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { faCalendar, faClock } from '@fortawesome/free-regular-svg-icons';
import { api } from './api';
import { useAuth } from './auth';

type Page<T> = { data: T[]; total: number };
type Job = {
  id: string;
  title: string;
  department: string;
  location: string;
  status: string;
  updated_at: string;
};
type Application = {
  id: string;
  candidate_name: string;
  job_title: string;
  created_at?: string;
};
type Interview = {
  id: string;
  application_id: string;
  starts_at: string;
  ends_at: string;
  mode: string;
  status: string;
  created_at?: string;
  panelist_ids?: string[];
  candidate_name?: string | null;
  job_title?: string;
  panel?: { full_name: string }[];
};
type FunnelRow = {
  stage: string;
  applicationCount: number;
};
type Activity = {
  id: string;
  kind: 'job' | 'application' | 'interview';
  title: string;
  detail: string;
  at: string;
};

const stages = [
  ['APPLIED', 'New applications'],
  ['SHORTLISTED', 'Shortlisted'],
  ['INTERVIEW', 'In interview'],
  ['OFFER', 'Offers'],
  ['HIRED', 'Hired'],
] as const;
const stageIcons = [
  faFileLines,
  faUsers,
  faCalendarDays,
  faEnvelope,
  faHandshake,
] as const;

const dateLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));

const relativeTime = (value: string) => {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const ranges: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
  ];
  let amount = seconds;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [limit, nextUnit] of ranges) {
    if (Math.abs(amount) < limit) break;
    amount = Math.round(amount / limit);
    unit = nextUnit;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    -amount,
    unit,
  );
};

function AutomationItem({
  title,
  detail,
  available,
}: {
  title: string;
  detail: string;
  available: boolean;
}) {
  return (
    <li>
      <span
        className={`automation-status ${available ? 'available' : 'unavailable'}`}
      >
        <FontAwesomeIcon
          icon={available ? faCircleCheck : faCircleMinus}
          aria-hidden="true"
        />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <span
        className={`status-pill ${available ? 'status-live' : 'status-muted'}`}
      >
        {available ? 'Available' : 'Unavailable'}
      </span>
    </li>
  );
}

export function Dashboard() {
  const { session } = useAuth();
  const [range, setRange] = useState(30);
  const period = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - range);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [range]);
  const query = useMemo(
    () =>
      new URLSearchParams({
        from: period.from,
        to: period.to,
      }).toString(),
    [period],
  );
  const isAdmin = session?.user.role === 'HR_ADMIN';
  // Job requests to approve (HR Admin), approved jobs to publish.
  const awaitingApproval = useQuery({
    queryKey: ['dashboard', 'awaiting-approval'],
    queryFn: () => api<Page<Job>>('/jobs?awaiting=approval&limit=1'),
    enabled: isAdmin,
  });
  const readyToPublish = useQuery({
    queryKey: ['dashboard', 'ready-to-publish'],
    queryFn: () => api<Page<Job>>('/jobs?status=APPROVED&limit=1'),
  });
  const recentJobs = useQuery({
    queryKey: ['dashboard', 'recent-jobs'],
    queryFn: () =>
      api<Page<Job>>('/jobs?limit=6&sort=updated_at&direction=desc'),
  });
  const publishedJobs = useQuery({
    queryKey: ['dashboard', 'published-jobs'],
    queryFn: () => api<Page<Job>>('/jobs?status=PUBLISHED&limit=1'),
  });
  const applications = useQuery({
    queryKey: ['dashboard', 'applications'],
    queryFn: () => api<Page<Application>>('/applications?limit=100'),
  });
  const interviews = useQuery({
    queryKey: ['dashboard', 'interviews'],
    queryFn: () =>
      api<Page<Interview>>('/interviews?status=SCHEDULED&limit=50'),
  });
  const funnel = useQuery({
    queryKey: ['dashboard', 'funnel', range],
    queryFn: () =>
      api<{ data: FunnelRow[] }>(`/reports/recruitment/funnel?${query}`),
  });
  // Optional extras: the dashboard still loads if these fail.
  const screened = useQuery({
    queryKey: ['dashboard', 'screened'],
    queryFn: () =>
      api<Page<Application>>('/applications?limit=1&screening=screened'),
  });
  const aiProviders = useQuery({
    queryKey: ['job-ai-providers'],
    queryFn: () => api<unknown[]>('/jobs/ai-description/providers'),
  });
  const aiOn = Array.isArray(aiProviders.data) && aiProviders.data.length > 0;
  const queries = [recentJobs, publishedJobs, applications, interviews, funnel];
  const pending = queries.some((item) => item.isPending);
  const failed = queries.some((item) => item.isError);
  const retry = () => {
    void Promise.all(queries.map((item) => item.refetch()));
  };
  const userName = session?.user.full_name.split(' ')[0] ?? 'there';
  const applicationById = new Map(
    (applications.data?.data ?? []).map((item) => [item.id, item]),
  );
  const upcoming = (interviews.data?.data ?? [])
    .filter(
      (item) =>
        item.status === 'SCHEDULED' &&
        new Date(item.starts_at).getTime() >= Date.now(),
    )
    .slice(0, 5);
  const recentActivity: Activity[] = [
    ...(recentJobs.data?.data ?? []).map((job) => ({
      id: `job-${job.id}`,
      kind: 'job' as const,
      title: `${job.title} ${
        job.status === 'PUBLISHED'
          ? 'published'
          : `updated · ${job.status.toLowerCase()}`
      }`,
      detail: `${job.department} · ${job.location}`,
      at: job.updated_at,
    })),
    ...(applications.data?.data ?? []).flatMap((application) =>
      application.created_at
        ? [
            {
              id: `application-${application.id}`,
              kind: 'application' as const,
              title: `New application — ${application.candidate_name}`,
              detail: application.job_title,
              at: application.created_at,
            },
          ]
        : [],
    ),
    ...(interviews.data?.data ?? []).flatMap((interview) => {
      if (!interview.created_at) return [];
      const application = applicationById.get(interview.application_id);
      return [
        {
          id: `interview-${interview.id}`,
          kind: 'interview' as const,
          title: `Interview scheduled — ${
            interview.candidate_name ??
            application?.candidate_name ??
            'Candidate'
          }`,
          detail:
            interview.job_title ??
            application?.job_title ??
            'Job title unavailable',
          at: interview.created_at,
        },
      ];
    }),
  ]
    .filter((item) => Number.isFinite(new Date(item.at).getTime()))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 5);
  const funnelCounts = new Map<string, number>();
  for (const item of funnel.data?.data ?? [])
    funnelCounts.set(
      item.stage,
      (funnelCounts.get(item.stage) ?? 0) + item.applicationCount,
    );
  const shortlisted = funnelCounts.get('SHORTLISTED') ?? 0;

  return (
    <section className="dashboard-page">
      <header className="dashboard-heading">
        <div>
          <h1>Welcome back, {userName} 👋</h1>
          <p className="intro">
            Here&apos;s your hiring overview for{' '}
            {session?.user.organization_name ?? 'your organization'}.
          </p>
        </div>
        <div className="dashboard-actions">
          <details className="dashboard-help">
            <summary aria-label="Dashboard help" title="Dashboard help">
              <FontAwesomeIcon icon={faCircleQuestion} aria-hidden="true" />
            </summary>
            <p>
              Metrics reflect hiring records available in this workspace.
              Unavailable automation is shown with a dash.
            </p>
          </details>
          <label className="range-select">
            <span className="sr-only">Report period</span>
            <FontAwesomeIcon
              className="range-calendar-icon"
              icon={faCalendar}
              aria-hidden="true"
            />
            <select
              aria-label="Report period"
              value={range}
              onChange={(event) => setRange(Number(event.target.value))}
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <FontAwesomeIcon
              className="range-chevron-icon"
              icon={faChevronDown}
              aria-hidden="true"
            />
          </label>
          {isAdmin && (
            <Link className="button-link button-primary" to="/jobs?create=1">
              <FontAwesomeIcon icon={faPlus} aria-hidden="true" /> Create Job
            </Link>
          )}
        </div>
      </header>

      {((awaitingApproval.data?.total ?? 0) > 0 ||
        (readyToPublish.data?.total ?? 0) > 0) && (
        <div className="dashboard-workflow" role="status">
          {(awaitingApproval.data?.total ?? 0) > 0 && (
            <Link to="/jobs?awaiting=approval">
              <strong>{awaitingApproval.data!.total}</strong>{' '}
              {awaitingApproval.data!.total === 1
                ? 'job request is'
                : 'job requests are'}{' '}
              waiting for your approval
            </Link>
          )}
          {(readyToPublish.data?.total ?? 0) > 0 && (
            <Link to="/jobs?status=APPROVED">
              <strong>{readyToPublish.data!.total}</strong> approved{' '}
              {readyToPublish.data!.total === 1 ? 'job is' : 'jobs are'} ready
              to publish
            </Link>
          )}
        </div>
      )}
      {pending ? (
        <p role="status" className="dashboard-notice">
          Loading your recruitment overview…
        </p>
      ) : failed ? (
        <div role="alert" className="dashboard-notice">
          Some dashboard data could not be loaded.
          <button onClick={retry}>Retry</button>
        </div>
      ) : (
        <>
          <div className="dashboard-kpis">
            <article className="dashboard-kpi">
              <span className="dashboard-kpi-icon" aria-hidden="true">
                <FontAwesomeIcon icon={faBriefcase} />
              </span>
              <div>
                <h2>Active jobs</h2>
                <strong>{publishedJobs.data?.total ?? 0}</strong>
                <p>Published in HireAI</p>
              </div>
            </article>
            <article className="dashboard-kpi">
              <span className="dashboard-kpi-icon" aria-hidden="true">
                <FontAwesomeIcon icon={faUsers} />
              </span>
              <div>
                <h2>Total applications</h2>
                <strong>{applications.data?.total ?? 0}</strong>
                <p>Across your organization</p>
              </div>
            </article>
            <article className="dashboard-kpi">
              <span className="dashboard-kpi-icon" aria-hidden="true">
                <FontAwesomeIcon icon={faWandMagicSparkles} />
              </span>
              <div>
                <h2>AI screened</h2>
                {screened.data ? (
                  <strong>{screened.data.total}</strong>
                ) : (
                  <strong aria-label="Unavailable">—</strong>
                )}
                <p>
                  {aiOn
                    ? 'Resumes rated against job criteria'
                    : 'Screening is not enabled'}
                </p>
              </div>
            </article>
            <article className="dashboard-kpi">
              <span className="dashboard-kpi-icon" aria-hidden="true">
                <FontAwesomeIcon icon={faPhone} />
              </span>
              <div>
                <h2>Calls completed</h2>
                <strong aria-label="Unavailable">—</strong>
                <p>Candidate calling is not enabled</p>
              </div>
            </article>
            <article className="dashboard-kpi">
              <span className="dashboard-kpi-icon" aria-hidden="true">
                <FontAwesomeIcon icon={faCalendarDays} />
              </span>
              <div>
                <h2>Scheduled interviews</h2>
                <strong>{interviews.data?.total ?? 0}</strong>
                <p>Scheduled records</p>
              </div>
            </article>
          </div>

          <div className="dashboard-body">
            <div className="dashboard-main">
              <div className="dashboard-grid dashboard-main-top">
                <section className="dashboard-panel funnel-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <h2>Recruitment funnel</h2>
                      <p>Applications entering each stage in this period.</p>
                    </div>
                    <span className="period-chip">Last {range} days</span>
                  </div>
                  <div className="funnel-content">
                    <div className="funnel-graphic" aria-hidden="true">
                      {stages.map(([stage], index) => {
                        const count = funnelCounts.get(stage) ?? 0;
                        const width = Math.max(12, 100 - index * 17);
                        return (
                          <div
                            key={stage}
                            className={`funnel-shape funnel-shape-${index + 1}`}
                            style={{
                              width: `${width}%`,
                              opacity: count ? 1 : 0.45,
                            }}
                          />
                        );
                      })}
                    </div>
                    <ul className="funnel-legend">
                      {stages.map(([stage, label], index) => (
                        <li key={stage}>
                          <span
                            className={`funnel-dot funnel-dot-${index + 1}`}
                          />
                          <span>{label}</span>
                          <strong>{funnelCounts.get(stage) ?? 0}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                <section className="dashboard-panel pipeline-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <h2>Candidate pipeline</h2>
                      <p>Recorded stage changes for the selected period.</p>
                    </div>
                    <Link to="/applications">View applications</Link>
                  </div>
                  <div className="pipeline-stages">
                    {stages.map(([stage, label], index) => (
                      <article className="pipeline-stage" key={stage}>
                        <span
                          className={`pipeline-stage-icon stage-${index + 1}`}
                        >
                          <FontAwesomeIcon
                            icon={stageIcons[index]}
                            aria-hidden="true"
                          />
                        </span>
                        <h3>{label}</h3>
                        <strong>{funnelCounts.get(stage) ?? 0}</strong>
                        {index < stages.length - 1 && (
                          <FontAwesomeIcon
                            className="pipeline-arrow"
                            icon={faArrowRight}
                            aria-hidden="true"
                          />
                        )}
                      </article>
                    ))}
                  </div>
                  <p className="dashboard-footnote">
                    Counts are based on recorded application-stage events; one
                    application may appear in multiple stages.
                  </p>
                </section>
              </div>

              <div className="dashboard-grid dashboard-main-bottom">
                <section className="dashboard-panel activity-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <h2>Recent job activity</h2>
                      <p>Recently updated job records.</p>
                    </div>
                    <Link to="/jobs">
                      View all jobs{' '}
                      <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                    </Link>
                  </div>
                  {recentActivity.length ? (
                    <ul className="activity-list">
                      {recentActivity.map((item) => (
                        <li key={item.id}>
                          <span
                            className={`activity-icon activity-${item.kind}`}
                            aria-hidden="true"
                          >
                            <FontAwesomeIcon
                              icon={
                                item.kind === 'application'
                                  ? faUsers
                                  : item.kind === 'interview'
                                    ? faCalendarDays
                                    : item.title.includes('published')
                                      ? faCircleCheck
                                      : faBriefcase
                              }
                            />
                          </span>
                          <span className="activity-copy">
                            <strong>{item.title}</strong>
                            <small>{item.detail}</small>
                          </span>
                          <time dateTime={item.at}>
                            {relativeTime(item.at)}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="empty-state">
                      No recent hiring activity to display.
                    </p>
                  )}
                </section>

                <section className="dashboard-panel interviews-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <h2>
                        <FontAwesomeIcon
                          icon={faCalendarDays}
                          aria-hidden="true"
                        />{' '}
                        Upcoming interviews
                      </h2>
                      <p>Scheduled interviews coming up.</p>
                    </div>
                    <Link to="/interviews">
                      View calendar{' '}
                      <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                    </Link>
                  </div>
                  {upcoming.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Candidate</th>
                            <th>Job title</th>
                            <th>
                              <FontAwesomeIcon
                                icon={faClock}
                                aria-hidden="true"
                              />{' '}
                              Date &amp; time
                            </th>
                            <th>Panelists</th>
                            <th>Mode</th>
                          </tr>
                        </thead>
                        <tbody>
                          {upcoming.map((interview) => {
                            const application = applicationById.get(
                              interview.application_id,
                            );
                            const candidate =
                              interview.candidate_name ??
                              application?.candidate_name ??
                              'Candidate';
                            return (
                              <tr key={interview.id}>
                                <td>
                                  <span className="dashboard-person">
                                    <span aria-hidden="true">
                                      {candidate
                                        .split(' ')
                                        .map((part) => part[0])
                                        .slice(0, 2)
                                        .join('')}
                                    </span>
                                    {candidate}
                                  </span>
                                </td>
                                <td>
                                  {interview.job_title ??
                                    application?.job_title ??
                                    '—'}
                                </td>
                                <td>{dateLabel(interview.starts_at)}</td>
                                <td>
                                  {interview.panel?.length
                                    ? interview.panel
                                        .map((person) => person.full_name)
                                        .join(', ')
                                    : interview.panelist_ids?.length
                                      ? `${interview.panelist_ids.length} assigned`
                                      : 'Not assigned'}
                                </td>
                                <td>
                                  <span
                                    className={`mode-chip mode-${interview.mode.toLowerCase()}`}
                                  >
                                    <FontAwesomeIcon
                                      icon={
                                        interview.mode === 'VIDEO' ||
                                        interview.mode === 'ONLINE'
                                          ? faVideo
                                          : interview.mode === 'PHONE'
                                            ? faPhone
                                            : faBuilding
                                      }
                                      aria-hidden="true"
                                    />{' '}
                                    {interview.mode.toLowerCase()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="empty-state">
                      No upcoming interviews scheduled.
                    </p>
                  )}
                </section>
              </div>
            </div>

            <aside className="dashboard-panel automation-panel">
              <div className="dashboard-panel-heading">
                <div>
                  <h2>
                    <FontAwesomeIcon
                      icon={faWandMagicSparkles}
                      aria-hidden="true"
                    />{' '}
                    AI Automation Status
                  </h2>
                  <p>Availability of recruitment automation features.</p>
                </div>
              </div>
              <ul className="automation-list">
                <AutomationItem
                  title="Job description generation"
                  available={aiOn}
                  detail={
                    aiOn
                      ? 'Draft descriptions from the job details'
                      : 'Manual descriptions are supported'
                  }
                />
                <AutomationItem
                  title="Resume screening"
                  available={aiOn}
                  detail={
                    aiOn
                      ? 'Resumes are rated against each job’s criteria'
                      : 'Enable an AI provider in Integrations'
                  }
                />
                <li>
                  <span className="automation-status unavailable">
                    <FontAwesomeIcon icon={faCircleMinus} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Candidate calling</strong>
                    <small>No automated calls are placed</small>
                  </span>
                  <span className="status-pill status-muted">Unavailable</span>
                </li>
                <li>
                  <span className="automation-status available">
                    <FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Interview scheduling</strong>
                    <small>Manual scheduling is available</small>
                  </span>
                  <span className="status-pill status-live">Available</span>
                </li>
              </ul>
              <section className="dashboard-insights">
                <h2>
                  <FontAwesomeIcon icon={faChartSimple} aria-hidden="true" />{' '}
                  Hiring insights
                </h2>
                <ul>
                  <li>
                    {shortlisted} candidates reached the shortlist stage in the
                    last {range} days.
                  </li>
                  <li>{upcoming.length} upcoming interviews are scheduled.</li>
                  <li>
                    {applications.data?.total ?? 0} applications are recorded
                    across your active jobs.
                  </li>
                </ul>
                <p>
                  Based on recorded data; AI-generated insights are not
                  available.
                </p>
                <Link to="/reports">
                  View reports{' '}
                  <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                </Link>
              </section>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
