import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faXmark } from '@fortawesome/free-solid-svg-icons';
import { api } from './api';

type TeamRole = 'HIRING_MANAGER' | 'INTERVIEWER' | 'RECRUITER_OWNER';
type Member = {
  id: string;
  user_id: string;
  role: TeamRole;
  full_name: string;
  email: string;
  active: boolean;
};
type Person = { id: string; full_name: string; role: string };

const roleNames: Record<TeamRole, string> = {
  HIRING_MANAGER: 'Hiring manager',
  INTERVIEWER: 'Interviewer',
  RECRUITER_OWNER: 'Recruiter',
};
/** The team role each account role is added as. */
const teamRoleFor: Record<string, TeamRole | undefined> = {
  HIRING_MANAGER: 'HIRING_MANAGER',
  INTERVIEWER: 'INTERVIEWER',
};
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * A job's hiring team: the hiring managers and interviewers who see its
 * applicants. An HR Admin adds and removes them; recruiters see who's on it.
 */
export function HiringTeamDialog({
  job,
  canEdit,
  onClose,
}: {
  job: { id: string; title: string };
  canEdit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [person, setPerson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  const team = useQuery({
    queryKey: ['job-team', job.id],
    queryFn: () => api<Member[]>(`/jobs/${job.id}/assignments`),
    retry: false,
  });
  const people = useQuery({
    queryKey: ['interview-panelists'],
    queryFn: () => api<{ data: Person[] }>('/interviews/panelists'),
    enabled: canEdit,
    retry: false,
  });
  const members = team.data ?? [];
  // Hiring managers and interviewers not on the team yet.
  const addable = (people.data?.data ?? []).filter(
    (p) =>
      teamRoleFor[p.role] &&
      !members.some(
        (m) => m.user_id === p.id && m.role === teamRoleFor[p.role],
      ),
  );

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['job-team', job.id] }),
      queryClient.invalidateQueries({ queryKey: ['jobs'] }),
    ]);
  }

  async function add() {
    const chosen = addable.find((p) => p.id === person);
    if (!chosen) {
      setError('Choose someone to add.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/jobs/${job.id}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          userId: chosen.id,
          role: teamRoleFor[chosen.role],
        }),
      });
      setPerson('');
      await refresh();
      setNotice(
        `${chosen.full_name} can now see ${job.title}’s applicants${
          chosen.role === 'HIRING_MANAGER'
            ? ' and shortlist or reject them'
            : ''
        }.`,
      );
    } catch (failure) {
      setError(message(failure, 'They couldn’t be added.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: Member) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/jobs/${job.id}/assignments/${member.id}`, {
        method: 'DELETE',
      });
      await refresh();
      setNotice(`${member.full_name} was taken off the hiring team.`);
    } catch (failure) {
      setError(message(failure, 'They couldn’t be removed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="job-dialog cand-dialog team-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              Hiring team
            </h2>
            <p>
              {job.title}: hiring managers see its applicants and shortlist or
              reject them; interviewers see its applicants.
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
        <div className="team-body">
          {team.isPending ? (
            <p className="cand-muted">Loading…</p>
          ) : team.isError ? (
            <p role="alert" className="form-error">
              {message(team.error, 'The hiring team couldn’t be loaded.')}
            </p>
          ) : members.length === 0 ? (
            <p className="cand-muted">
              No one yet: this job’s applicants are only seen by HR Admins and
              recruiters.
            </p>
          ) : (
            <ul className="team-list" aria-label="Hiring team">
              {members.map((member) => (
                <li key={member.id}>
                  <span>
                    <strong>{member.full_name}</strong>
                    <small>
                      {roleNames[member.role]} · {member.email}
                      {member.active ? '' : ' · inactive'}
                    </small>
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${member.full_name}`}
                      onClick={() => void remove(member)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="team-add">
              <label className="form-field">
                Add a hiring manager or interviewer
                <span className="select-control">
                  <select
                    value={person}
                    disabled={busy || !addable.length}
                    onChange={(event) => setPerson(event.target.value)}
                  >
                    <option value="">
                      {people.isPending
                        ? 'Loading…'
                        : addable.length
                          ? 'Choose someone'
                          : 'No one else to add'}
                    </option>
                    {addable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name} ·{' '}
                        {roleNames[teamRoleFor[p.role] as TeamRole]}
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
              <button
                type="button"
                className="button-primary"
                disabled={busy || !person}
                onClick={() => void add()}
              >
                {busy ? 'Saving…' : 'Add to team'}
              </button>
            </div>
          )}
          {canEdit && people.isSuccess && !addable.length && (
            <p className="cand-muted">
              Invite hiring managers and interviewers in{' '}
              <Link to="/team">Team &amp; invitations</Link>, then add them
              here.
            </p>
          )}
          {!canEdit && (
            <p className="cand-muted">An HR Admin changes the hiring team.</p>
          )}
          {notice && (
            <p role="status" className="form-success">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
