import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
const base = '/organization/integrations/linkedin';
type Preview = {
  id: string;
  jobTitle: string;
  request: {
    integrationContext?: string;
    companyApplyUrl?: string;
    description?: string;
    location?: string;
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
export function LinkedInPublishing() {
  const [preview, setPreview] = useState<Preview | null>(null),
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
    <section className="integration-card">
      <h2>LinkedIn Jobs</h2>
      <p>
        Choose a published job and its public career page, review the listing,
        then confirm publication to LinkedIn Jobs.
      </p>
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
              channel: 'job_listing',
              applicationUrl: values.get('applicationUrl'),
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
          <p>
            Requires LinkedIn partner-approved onboarding for this
            organization. Basic job submissions are asynchronous; provider
            eligibility rules still apply.
          </p>
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
          <button disabled={busy}>Preview LinkedIn Jobs listing</button>
        </form>
      )}
      {preview && (
        <section className="integration-card">
          <h3>Review before publishing</h3>
          <p>
            <strong>{preview.jobTitle}</strong>
          </p>
          <p>LinkedIn Jobs listing</p>
          <p>Company: {preview.request.integrationContext}</p>
          {preview.request.location && (
            <p>Location: {preview.request.location}</p>
          )}
          <p className="publication-copy">
            {preview.request.description}
          </p>
          <p>Apply at: {preview.request.companyApplyUrl}</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I have reviewed this job listing and authorize publishing it to
            LinkedIn Jobs.
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
            Publish LinkedIn Jobs listing
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
        <div className="integration-grid">
          {history.data.map((p) => (
            <article key={p.id} className="integration-card">
              <p>LinkedIn Jobs</p>
              <p>Status: {p.status}</p>
              <p>{new Date(p.created_at).toLocaleString()}</p>
              {['SENDING', 'UNKNOWN'].includes(p.status) && (
                <p>
                  Delivery is unconfirmed. Check LinkedIn before asking your
                  administrator to reconcile it; this request will not be sent
                  again automatically.
                </p>
              )}
              {p.status === 'PROCESSED' && (
                <p>
                  LinkedIn processed the job, but has not confirmed a live
                  listing.
                </p>
              )}
              {['SUBMITTED', 'PROCESSED'].includes(p.status) && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    const r = await run('/publications/' + p.id + '/refresh');
                    if (r) setMessage('Publication status: ' + r.status);
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
                  View on LinkedIn
                </a>
              )}
            </article>
          ))}
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
        Jobs employer mapping after partner approval. Credentials remain
        encrypted; organization admins verify and enable each environment.
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
          LinkedIn organization URN (Jobs employer mapping)
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
