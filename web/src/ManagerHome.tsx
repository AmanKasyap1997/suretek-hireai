import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBriefcase,
  faCalendarDays,
  faClipboardCheck,
  faUserCheck,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';
import { useAuth } from './auth';
import { roleLabel, type Role } from './permissions';
import { whenLabel, type Interview } from './Interviews';

type Stage =
  'APPLIED' | 'SHORTLISTED' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
type Job = {
  id: string;
  title: string;
  department: string;
  location: string;
  status: 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'CLOSED';
  requested_at?: string | null;
  review_note?: string | null;
};

/** Where a job is between request and publishing. */
function requestStatus(job: Job) {
  if (job.status === 'APPROVED') return 'Approved: a recruiter publishes it';
  if (job.requested_at) return 'Awaiting HR Admin approval';
  if (job.review_note) return `Sent back: ${job.review_note}`;
  return 'Draft: submit it for approval';
}
type Applicant = {
  id: string;
  candidate_name: string;
  job_title: string;
  created_at: string;
  screening_score: number | null;
};
type Applicants = {
  data: Applicant[];
  total: number;
  stage_counts?: Partial<Record<Stage, number>>;
};

const day = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** A job's applicants by stage, for its row. */
function JobCounts({ jobId }: { jobId: string }) {
  const counts = useQuery({
    queryKey: ['manager-home', 'job-counts', jobId],
    queryFn: () =>
      api<Applicants>(`/applications?jobId=${jobId}&counts=true&limit=1`),
    retry: false,
  });
  const by = counts.data?.stage_counts ?? {};
  if (!counts.data) return <span className="cand-muted">…</span>;
  return (
    <span className="mh-counts">
      <span>{by.APPLIED ?? 0} new</span>
      <span>{by.SHORTLISTED ?? 0} shortlisted</span>
      <span>{by.INTERVIEW ?? 0} interviewing</span>
    </span>
  );
}

/**
 * Home for hiring managers and interviewers: the jobs they're on, applicants
 * waiting for a decision, their interviews, and feedback they owe.
 */
export function ManagerHome() {
  const user = useAuth().session?.user;
  const role = user?.role as Role | undefined;
  const manager = role === 'HIRING_MANAGER';
  const jobs = useQuery({
    queryKey: ['manager-home', 'jobs'],
    queryFn: () =>
      api<{ data: Job[]; total: number }>(
        '/jobs?limit=100&sort=updated_at&direction=desc',
      ),
    retry: false,
  });
  const toReview = useQuery({
    queryKey: ['manager-home', 'to-review'],
    queryFn: () =>
      api<Applicants>('/applications?stage=APPLIED&counts=true&limit=5'),
    retry: false,
  });
  const upcoming = useQuery({
    queryKey: ['manager-home', 'upcoming'],
    queryFn: () =>
      api<{ data: Interview[]; total: number }>(
        '/interviews?when=upcoming&limit=5',
      ),
    retry: false,
  });
  const past = useQuery({
    queryKey: ['manager-home', 'past'],
    queryFn: () =>
      api<{ data: Interview[]; total: number }>(
        '/interviews?when=past&limit=50',
      ),
    retry: false,
  });
  const openJobs = (jobs.data?.data ?? []).filter(
    (job) => job.status !== 'CLOSED',
  );
  const counts = toReview.data?.stage_counts ?? {};
  const feedbackDue = (past.data?.data ?? []).filter(
    (interview) => !interview.my_scorecard,
  );
  const failed = [jobs, toReview, upcoming, past].find((q) => q.isError);
  const first = user?.full_name.split(' ')[0] ?? 'there';

  return (
    <section className="mh-page" aria-labelledby="manager-home-title">
      <header className="cand-heading">
        <div>
          <p className="eyebrow">{role ? roleLabel(role).toUpperCase() : ''}</p>
          <h1 id="manager-home-title">Welcome, {first}</h1>
          <p className="intro">
            {manager
              ? 'Request jobs, review their applicants, join your interviews and give feedback.'
              : 'Your interviews, the applicants for your jobs, and the feedback you owe.'}
          </p>
        </div>
        {manager && (
          <Link className="button-link button-primary" to="/jobs?create=1">
            Request a Job
          </Link>
        )}
      </header>
      {failed && (
        <p role="alert" className="form-error">
          {message(failed.error, 'Some of your work couldn’t be loaded.')}
        </p>
      )}

      <div className="mh-stats">
        <Link to="/jobs" className="mh-stat">
          <FontAwesomeIcon icon={faBriefcase} aria-hidden="true" />
          <strong>{jobs.data ? openJobs.length : '…'}</strong>
          <span>Your open jobs</span>
        </Link>
        <Link to="/applications" className="mh-stat">
          <FontAwesomeIcon icon={faUsers} aria-hidden="true" />
          <strong>{toReview.data ? toReview.data.total : '…'}</strong>
          <span>New applicants{manager ? ' to review' : ''}</span>
        </Link>
        <Link to="/applications" className="mh-stat">
          <FontAwesomeIcon icon={faUserCheck} aria-hidden="true" />
          <strong>{toReview.data ? (counts.SHORTLISTED ?? 0) : '…'}</strong>
          <span>Shortlisted</span>
        </Link>
        <Link to="/interviews" className="mh-stat">
          <FontAwesomeIcon icon={faCalendarDays} aria-hidden="true" />
          <strong>{upcoming.data ? upcoming.data.total : '…'}</strong>
          <span>Upcoming interviews</span>
        </Link>
      </div>

      {jobs.data && jobs.data.total === 0 ? (
        <div className="mh-card mh-empty">
          <h2>No jobs yet</h2>
          <p>
            {manager
              ? 'Request a job, and follow it here as an HR Admin approves it and a recruiter publishes it. Jobs an HR Admin adds you to (Jobs → Hiring team) appear here too.'
              : 'You’ll see a job here once an HR Admin adds you to its hiring team (Jobs → Hiring team). Interviews you’re on appear below either way.'}
          </p>
        </div>
      ) : null}

      <div className="mh-grid">
        <section className="mh-card" aria-labelledby="mh-review">
          <h2 id="mh-review">
            <FontAwesomeIcon icon={faUsers} aria-hidden="true" />{' '}
            {manager ? 'Applicants to review' : 'New applicants'}
          </h2>
          {toReview.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : !toReview.data?.data.length ? (
            <p className="cand-muted">No new applicants.</p>
          ) : (
            <ul className="mh-list">
              {toReview.data.data.map((applicant) => (
                <li key={applicant.id}>
                  <span>
                    <Link to={`/applications?application=${applicant.id}`}>
                      {applicant.candidate_name}
                    </Link>
                    <small>
                      {applicant.job_title} · applied{' '}
                      {day(applicant.created_at)}
                    </small>
                  </span>
                  {applicant.screening_score !== null && (
                    <span
                      className="mh-score"
                      aria-label={`Match score ${applicant.screening_score}`}
                    >
                      {applicant.screening_score}%
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {manager && (
            <p className="mh-hint">
              Open an applicant to read their resume and AI screening, then
              shortlist or reject them.
            </p>
          )}
        </section>

        <section className="mh-card" aria-labelledby="mh-interviews">
          <h2 id="mh-interviews">
            <FontAwesomeIcon icon={faCalendarDays} aria-hidden="true" /> Your
            upcoming interviews
          </h2>
          {upcoming.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : !upcoming.data?.data.length ? (
            <p className="cand-muted">No interviews scheduled with you.</p>
          ) : (
            <ul className="mh-list">
              {upcoming.data.data.map((interview) => (
                <li key={interview.id}>
                  <span>
                    <Link to={`/interviews?interview=${interview.id}`}>
                      {interview.candidate_name ?? 'Candidate'} ·{' '}
                      {interview.round}
                    </Link>
                    <small>
                      {interview.job_title} · {whenLabel(interview)}
                    </small>
                  </span>
                  {interview.mode === 'VIDEO' && interview.meeting_url && (
                    <a
                      className="mh-join"
                      href={interview.meeting_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Join
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mh-card" aria-labelledby="mh-feedback">
          <h2 id="mh-feedback">
            <FontAwesomeIcon icon={faClipboardCheck} aria-hidden="true" />{' '}
            Feedback due
          </h2>
          {past.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : !feedbackDue.length ? (
            <p className="cand-muted">You’re up to date.</p>
          ) : (
            <ul className="mh-list">
              {feedbackDue.slice(0, 5).map((interview) => (
                <li key={interview.id}>
                  <span>
                    <Link to={`/interviews?interview=${interview.id}`}>
                      {interview.candidate_name ?? 'Candidate'} ·{' '}
                      {interview.round}
                    </Link>
                    <small>
                      {interview.job_title} · {whenLabel(interview)}
                    </small>
                  </span>
                  <Link
                    className="mh-join"
                    to={`/interviews?interview=${interview.id}`}
                  >
                    Give feedback
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mh-card" aria-labelledby="mh-jobs">
          <h2 id="mh-jobs">
            <FontAwesomeIcon icon={faBriefcase} aria-hidden="true" /> Your jobs
          </h2>
          {jobs.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : !openJobs.length ? (
            <p className="cand-muted">No open jobs.</p>
          ) : (
            <ul className="mh-list">
              {openJobs.slice(0, 8).map((job) => (
                <li key={job.id}>
                  <span>
                    <Link
                      to={
                        job.status === 'PUBLISHED'
                          ? `/applications?job=${job.id}`
                          : '/jobs'
                      }
                    >
                      {job.title}
                    </Link>
                    <small>
                      {job.department} · {job.location}
                    </small>
                  </span>
                  {job.status === 'PUBLISHED' ? (
                    <JobCounts jobId={job.id} />
                  ) : (
                    <span
                      className={`mh-request${job.review_note && !job.requested_at && job.status === 'DRAFT' ? ' mh-request-back' : ''}`}
                    >
                      {requestStatus(job)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
