import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faBullhorn,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';

/** A publication's status, in words and colour. */
function publicationStatus(status: string) {
  const text = status[0] + status.slice(1).toLowerCase().replace(/_/g, ' ');
  const tone = ['PUBLISHED', 'LIVE'].includes(status)
    ? 'success'
    : status === 'FAILED'
      ? 'danger'
      : ['REMOVED', 'CLOSED'].includes(status)
        ? 'neutral'
        : 'warning';
  return { text, tone };
}
const base = '/organization/integrations/linkedin';
type Preview = {
  id: string;
  channel: string;
  jobTitle: string;
  request: {
    commentary?: string;
    author?: string;
    integrationContext?: string;
    companyApplyUrl?: string;
    description?: string;
    location?: string;
    content?: { article: { source: string } };
  };
};
type Publication = {
  id: string;
  job_id: string;
  channel: string;
  status: string;
  remote_url: string | null;
  created_at: string;
};
export function LinkedInPublishing({
  social,
  jobsEnabled,
}: {
  social: boolean;
  jobsEnabled: boolean;
}) {
  const [channel, setChannel] = useState(
      social ? 'company_announcement' : 'job_listing',
    ),
    [start, setStart] = useState(0),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const cache = useQueryClient();
  const jobs = useQuery({
    queryKey: ['organization-integrations', 'linkedin-jobs'],
    queryFn: () =>
      api<{ id: string; title: string; location: string }[]>(base + '/jobs'),
    retry: false,
  });
  const pages = useQuery({
    queryKey: ['organization-integrations', 'linkedin-pages', start],
    queryFn: () =>
      api<{ pages: { urn: string; name: string }[]; nextStart: number | null }>(
        base + '/pages?start=' + start,
      ),
    enabled: channel === 'company_announcement',
    retry: false,
  });
  const history = useQuery({
    queryKey: ['organization-integrations', 'linkedin-publications'],
    queryFn: () => api<Publication[]>(base + '/publications'),
    retry: false,
  });
  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<Preview & { status: string }>(base + path, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      await cache.invalidateQueries({
        queryKey: ['organization-integrations', 'linkedin-publications'],
      });
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to complete request');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="integration-card li-publishing">
      <div className="li-banner">
        <span className="li-banner-icon" aria-hidden="true">
          <FontAwesomeIcon icon={faBullhorn} />
        </span>
        <div>
          <h2>Publish jobs to LinkedIn</h2>
          <p>
            Choose an existing published job, preview the content, then confirm
            publication. Company-page announcements and LinkedIn Jobs listings
            are separate actions.
          </p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {jobs.isPending ? (
        <p role="status">Loading jobs…</p>
      ) : jobs.isError ? (
        <p role="alert">
          Jobs could not be loaded.{' '}
          <button onClick={() => void jobs.refetch()}>Retry</button>
        </p>
      ) : !jobs.data.length ? (
        <p>No published jobs are available yet.</p>
      ) : (
        <form
          className="platform-form"
          onChange={() => {
            setPreview(null);
            setConfirmed(false);
          }}
          onSubmit={async (e) => {
            e.preventDefault();
            const values = new FormData(e.currentTarget);
            const result = await run('/preview', {
              jobId: values.get('jobId'),
              channel,
              applicationUrl: values.get('applicationUrl'),
              ...(channel === 'company_announcement'
                ? {
                    pageUrn: values.get('pageUrn'),
                    pageStart: start,
                    commentary: values.get('commentary'),
                  }
                : {}),
            });
            if (result) setPreview(result);
          }}
        >
          <label>
            Published job
            <select required name="jobId">
              <option value="">Select a job</option>
              {jobs.data.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title} — {j.location}
                </option>
              ))}
            </select>
          </label>
          <label>
            Publish as
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              {social && (
                <option value="company_announcement">
                  Company-page announcement
                </option>
              )}
              {jobsEnabled && (
                <option value="job_listing">LinkedIn Jobs listing</option>
              )}
            </select>
          </label>
          {channel === 'company_announcement' ? (
            <>
              {pages.isPending ? (
                <p>Loading authorized company pages…</p>
              ) : pages.isError ? (
                <p role="alert">
                  Connect, verify and enable LinkedIn company pages first, then{' '}
                  <button type="button" onClick={() => void pages.refetch()}>
                    load pages again
                  </button>
                  .
                </p>
              ) : (
                <>
                  <label>
                    Company page
                    <select key={start} name="pageUrn" required>
                      <option value="">Select an authorized page</option>
                      {pages.data?.pages.map((p) => (
                        <option key={p.urn} value={p.urn}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="integration-actions">
                    <button
                      type="button"
                      disabled={start === 0}
                      onClick={() => {
                        setStart(Math.max(0, start - 25));
                        setPreview(null);
                      }}
                    >
                      Previous pages
                    </button>
                    <button
                      type="button"
                      disabled={pages.data?.nextStart == null}
                      onClick={() => {
                        setStart(pages.data!.nextStart!);
                        setPreview(null);
                      }}
                    >
                      More pages
                    </button>
                  </div>
                </>
              )}
              <label>
                Announcement text
                <textarea
                  name="commentary"
                  maxLength={2000}
                  placeholder="Optional: write your job announcement"
                />
              </label>
            </>
          ) : (
            <p>
              Requires LinkedIn partner-approved onboarding for this
              organization. Basic job submissions are asynchronous; provider
              eligibility rules still apply.
            </p>
          )}
          <label>
            Application page URL
            <input
              name="applicationUrl"
              type="url"
              required
              placeholder="https://careers.example.com/jobs/…"
              maxLength={2048}
            />
          </label>
          <button
            disabled={
              busy ||
              (channel === 'company_announcement' &&
                (pages.isPending || pages.isError || !pages.data?.pages.length))
            }
          >
            Preview publication
          </button>
        </form>
      )}
      {preview && (
        <section className="integration-card">
          <h3>Review before publishing</h3>
          <p>
            <strong>{preview.jobTitle}</strong>
          </p>
          <p>
            {preview.channel === 'job_listing'
              ? 'LinkedIn Jobs listing'
              : 'Company-page announcement'}
          </p>
          <p>
            Company:{' '}
            {preview.request.author ?? preview.request.integrationContext}
          </p>
          {preview.request.location && (
            <p>Location: {preview.request.location}</p>
          )}
          <p className="publication-copy">
            {preview.request.commentary ?? preview.request.description}
          </p>
          <p>
            Apply at:{' '}
            {preview.request.companyApplyUrl ??
              preview.request.content?.article.source}
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I have reviewed this content and authorize publishing it publicly to
            LinkedIn.
          </label>
          <button
            disabled={busy || !confirmed}
            onClick={async () => {
              const result = await run(
                '/publications/' + preview.id + '/publish',
                { confirmed: true },
              );
              if (result) {
                setMessage('Publication status: ' + result.status);
                setPreview(null);
                setConfirmed(false);
              }
            }}
          >
            Publish to LinkedIn
          </button>
        </section>
      )}
      <h3>Publication history</h3>
      {history.isPending ? (
        <p>Loading publications…</p>
      ) : history.isError ? (
        <p role="alert">
          Unable to load history.{' '}
          <button onClick={() => void history.refetch()}>Retry history</button>
        </p>
      ) : !history.data.length ? (
        <p>No publications yet.</p>
      ) : (
        <div className="table-scroll li-history-scroll">
          <table className="li-history">
            <thead>
              <tr>
                <th>Job</th>
                <th>Published to</th>
                <th>Status</th>
                <th>Date</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((p) => {
                const status = publicationStatus(p.status);
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="li-history-job">
                        <span
                          className="int-mark int-mark-linkedin"
                          aria-hidden="true"
                        >
                          in
                        </span>
                        {jobs.data?.find((j) => j.id === p.job_id)?.title ??
                          'Job no longer published'}
                      </span>
                    </td>
                    <td>
                      {p.channel === 'job_listing'
                        ? 'LinkedIn Jobs'
                        : 'Company-page announcement'}
                    </td>
                    <td>
                      <span className={`int-pill int-pill-${status.tone}`}>
                        {status.text}
                      </span>
                      {['SENDING', 'UNKNOWN'].includes(p.status) && (
                        <small>
                          Delivery is unconfirmed. Check LinkedIn before asking
                          your administrator to reconcile it; this request will
                          not be sent again automatically.
                        </small>
                      )}
                      {p.status === 'PROCESSED' && (
                        <small>
                          LinkedIn processed the job, but has not confirmed a
                          live listing.
                        </small>
                      )}
                    </td>
                    <td>{new Date(p.created_at).toLocaleString()}</td>
                    <td>
                      <span className="li-history-actions">
                        {['SUBMITTED', 'PROCESSED'].includes(p.status) && (
                          <button
                            disabled={busy}
                            onClick={async () => {
                              const r = await run(
                                '/publications/' + p.id + '/refresh',
                              );
                              if (r)
                                setMessage('Publication status: ' + r.status);
                            }}
                          >
                            Check LinkedIn status
                          </button>
                        )}
                        {p.remote_url && (
                          <a
                            href={p.remote_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View on LinkedIn{' '}
                            <FontAwesomeIcon
                              icon={faArrowUpRightFromSquare}
                              aria-hidden="true"
                            />
                          </a>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function LinkedInPartnerSetup() {
  const [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>LinkedIn Jobs partner onboarding</summary>
      <p>
        Configure each organization's LinkedIn-issued customer application and
        company mapping after partner approval. Credentials remain encrypted;
        organization admins verify and enable each environment.
      </p>
      <form
        className="platform-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          setMessage('');
          const form = e.currentTarget,
            v = new FormData(form);
          try {
            await api(
              '/super-admin/integration-providers/linkedin-jobs/organizations/' +
                v.get('organizationId'),
              {
                method: 'POST',
                body: JSON.stringify({
                  environment: v.get('environment'),
                  companyUrn: v.get('companyUrn'),
                  clientId: v.get('clientId'),
                  clientSecret: v.get('clientSecret'),
                }),
              },
            );
            form.reset();
            setMessage('Organization partner connection saved.');
          } catch (e) {
            setError(
              e instanceof Error ? e.message : 'Unable to save onboarding',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Organization ID
          <input name="organizationId" required pattern="[0-9a-fA-F-]{36}" />
        </label>
        <label>
          Environment
          <select name="environment">
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </label>
        <label>
          LinkedIn company URN
          <input
            name="companyUrn"
            required
            pattern="urn:li:organization:[0-9]+"
            placeholder="urn:li:organization:123456"
          />
        </label>
        <label>
          Customer application client ID
          <input name="clientId" required autoComplete="off" maxLength={1024} />
        </label>
        <label>
          Customer application client secret
          <input
            name="clientSecret"
            type="password"
            required
            minLength={8}
            maxLength={8192}
            autoComplete="off"
          />
        </label>
        <button disabled={busy}>Save partner connection</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
