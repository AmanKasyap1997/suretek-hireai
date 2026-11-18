import { LinkedInPublishing, LinkedInPartnerSetup } from './LinkedInPublishing';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
type Provider = {
  hostedOAuth?: boolean;
  oauthReady?: boolean;
  platformManaged?: boolean;
  setupMessage?: string | null;
  provider: string;
  label: string;
  methods: string[];
  fields: Record<string, string[]>;
  enabled: boolean;
};
type Connection = {
  id: string;
  provider: string;
  environment: string;
  method: string;
  status: string;
  credential_hint: string;
  last_verified_at: string | null;
};
const base = '/organization/integrations';
const labels: Record<string, string> = {
  apiKey: 'API key',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  accessToken: 'Access token',
  refreshToken: 'Refresh token',
  api_key: 'API key',
  bearer: 'Access token',
  oauth2: 'OAuth consent',
  oauth_client_credentials: 'OAuth client credentials',
  oauth_refresh_token: 'OAuth refresh token',
  smtp: 'SMTP',
  basic: 'Username and password',
};
const label = (s: string) =>
  labels[s] ?? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
function useAction() {
  const client = useQueryClient(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ ok?: boolean; authorizationUrl?: string }>(
        path,
        {
          method,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      );
      setMessage(
        result?.ok === false
          ? 'Connection verification failed. Check credentials and provider configuration.'
          : 'Changes saved.',
      );
      await client.invalidateQueries({
        queryKey: ['organization-integrations'],
      });
      return result ?? {};
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save changes');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, run };
}
function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </>
  );
}
export function ProviderAvailability() {
  const q = useQuery({
      queryKey: ['organization-integrations', 'availability'],
      queryFn: () => api<Provider[]>('/super-admin/integration-providers'),
    }),
    action = useAction();
  return (
    <section>
      <h2>Available to organizations</h2>
      <p>
        Google, Microsoft and LinkedIn use a provider authorization screen.
        Configure the platform OAuth application once; organization admins never
        need its client secret.
      </p>
      <LinkedInPartnerSetup />
      <p>
        Enable a provider to let organization admins connect their own accounts.
        Disabling it immediately prevents organizations from testing or enabling
        connections. Re-enabling requires new verification.
      </p>
      <Feedback action={action} />
      {q.isPending ? (
        <p role="status">Loading providers…</p>
      ) : q.isError ? (
        <p role="alert">
          Unable to load providers.{' '}
          <button onClick={() => void q.refetch()}>Retry</button>
        </p>
      ) : (
        <div className="integration-grid">
          {q.data.map((p) => (
            <article className="integration-card" key={p.provider}>
              <h3>{p.label}</h3>
              <p>
                {p.enabled ? 'Available to organization admins' : 'Disabled'}
              </p>
              <button
                disabled={action.busy}
                onClick={() => {
                  if (
                    p.enabled &&
                    !window.confirm(
                      `Disable ${p.label} for every organization?`,
                    )
                  )
                    return;
                  void action.run(
                    '/super-admin/integration-providers/' + p.provider,
                    'PATCH',
                    { enabled: !p.enabled },
                  );
                }}
              >
                {p.enabled ? 'Disable' : 'Enable'} {p.label}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function ConnectionForm({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
}) {
  const [method, setMethod] = useState(provider.methods[0]),
    action = useAction();
  return (
    <section className="integration-card">
      <h2>Connect {provider.label}</h2>
      <p>
        Credentials belong only to your organization. Test sandbox before
        enabling production.
      </p>
      <form
        className="platform-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            values = new FormData(form);
          const popup =
            method === 'oauth2'
              ? window.open(
                  'about:blank',
                  'hireai-provider',
                  'popup,width=620,height=760',
                )
              : null;
          if (popup) popup.opener = null;
          const credentials = Object.fromEntries(
            provider.fields[method]
              .map((field) => [field, String(values.get(field) ?? '')])
              .filter(([, value]) => value),
          );
          const input = {
            provider: provider.provider,
            environment: values.get('environment'),
            method,
            credentials,
          };
          const result = await action.run(
            base + (method === 'oauth2' ? '/oauth/start' : ''),
            'POST',
            input,
          );
          if (result?.authorizationUrl) {
            if (popup) popup.location.replace(result.authorizationUrl);
            else window.location.assign(result.authorizationUrl);
          } else {
            popup?.close();
            if (result) form.reset();
          }
        }}
      >
        <label>
          Environment
          <select name="environment">
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </label>
        <label>
          Connection method
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {provider.methods.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
        <div key={method}>
          {provider.fields[method].map((field) => (
            <label key={field}>
              {label(field)}
              <input
                name={field}
                type={
                  ['username', 'clientId', 'scope'].includes(field)
                    ? 'text'
                    : 'password'
                }
                autoComplete="off"
                required={field !== 'scope'}
                minLength={
                  ['username', 'clientId', 'scope'].includes(field) ? 1 : 8
                }
                maxLength={8192}
              />
            </label>
          ))}
        </div>
        {method === 'oauth2' && provider.hostedOAuth && (
          <p>
            You will sign in and approve access on {provider.label}’s website.
            HireAI does not ask for your provider password.
          </p>
        )}
        {method === 'oauth2' && !provider.hostedOAuth && (
          <p>
            Register the callback URL{' '}
            <code>{window.location.origin}/console/integrations/oauth</code> in
            your provider application. You will continue to the provider’s
            consent screen.
          </p>
        )}
        {method === 'smtp' && (
          <p>
            The platform operator configures the trusted SMTP server. Enter your
            organization’s SMTP credentials.
          </p>
        )}
        {provider.setupMessage && <p role="status">{provider.setupMessage}</p>}
        <button
          disabled={
            action.busy ||
            (method === 'oauth2' && provider.oauthReady === false)
          }
        >
          {action.busy
            ? 'Saving…'
            : method === 'oauth2'
              ? 'Connect with ' + provider.label
              : 'Save connection'}
        </button>
        <button type="button" disabled={action.busy} onClick={onClose}>
          Close
        </button>
      </form>
      <Feedback action={action} />
    </section>
  );
}
export function OrganizationIntegrations() {
  const { session } = useAuth();
  if (
    !session ||
    session.user.role === 'SUPER_ADMIN' ||
    ![session.user.role, ...(session.user.roles ?? [])].includes('HR_ADMIN')
  )
    return <h1>Not authorized</h1>;
  return <OrganizationConnections />;
}
function OrganizationConnections() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('hireai-provider-connection');
    channel.onmessage = () =>
      void queryClient.invalidateQueries({
        queryKey: ['organization-integrations'],
      });
    return () => channel.close();
  }, [queryClient]);
  const providers = useQuery({
      queryKey: ['organization-integrations', 'providers'],
      queryFn: () => api<Provider[]>(base + '/providers'),
    }),
    connections = useQuery({
      queryKey: ['organization-integrations', 'connections'],
      queryFn: () => api<Connection[]>(base),
    }),
    action = useAction(),
    [selected, setSelected] = useState<string | null>(null);
  const provider = providers.data?.find((p) => p.provider === selected);
  return (
    <>
      <h1>Integrations</h1>
      <p>
        Connect your organization’s accounts to providers enabled by Suretek.
      </p>
      <Feedback action={action} />
      {providers.isPending || connections.isPending ? (
        <p role="status">Loading integrations…</p>
      ) : providers.isError || connections.isError ? (
        <p role="alert">
          Unable to load integrations.{' '}
          <button
            onClick={() => {
              void providers.refetch();
              void connections.refetch();
            }}
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          {providers.data.length === 0 ? (
            <p>
              No providers are enabled. Contact your platform administrator.
            </p>
          ) : (
            <div className="integration-grid">
              {providers.data.map((p) => (
                <article className="integration-card" key={p.provider}>
                  <h2>{p.label}</h2>
                  {p.platformManaged ? (
                    <p>{p.setupMessage}</p>
                  ) : (
                    <button onClick={() => setSelected(p.provider)}>
                      Connect {p.label}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
          {provider && (
            <ConnectionForm
              key={provider.provider}
              provider={provider}
              onClose={() => setSelected(null)}
            />
          )}
          <h2>Your connections</h2>
          {connections.data.length === 0 ? (
            <p>No connections yet.</p>
          ) : (
            <div className="integration-grid">
              {connections.data.map((c) => (
                <article className="integration-card" key={c.id}>
                  <h3>
                    {label(c.provider)} · {c.environment}
                  </h3>
                  <p>
                    {label(c.method)} · {c.credential_hint}
                  </p>
                  <p>Status: {c.status}</p>
                  <p>
                    Last verified:{' '}
                    {c.last_verified_at
                      ? new Date(c.last_verified_at).toLocaleString()
                      : 'Not verified'}
                  </p>
                  <div className="integration-actions">
                    <button
                      disabled={
                        action.busy ||
                        c.status === 'disabled' ||
                        c.credential_hint === 'Disconnected'
                      }
                      onClick={() =>
                        void action.run(base + '/' + c.id + '/test', 'POST')
                      }
                    >
                      Test connection
                    </button>
                    <button
                      disabled={
                        action.busy || !['ok', 'enabled'].includes(c.status)
                      }
                      onClick={() =>
                        void action.run(base + '/' + c.id + '/enable', 'POST')
                      }
                    >
                      Enable connection
                    </button>
                    <button
                      disabled={
                        action.busy || c.credential_hint === 'Disconnected'
                      }
                      onClick={() => {
                        if (
                          window.confirm(
                            'Disconnect this account and remove its credentials?',
                          )
                        )
                          void action.run(base + '/' + c.id, 'DELETE');
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {session?.user.enabled_modules?.includes('hiring') &&
        providers.data?.some(
          (p) => p.provider === 'linkedin' || p.provider === 'linkedin_jobs',
        ) && (
          <LinkedInPublishing
            social={!!providers.data?.some((p) => p.provider === 'linkedin')}
            jobsEnabled={
              !!providers.data?.some((p) => p.provider === 'linkedin_jobs')
            }
          />
        )}
    </>
  );
}
export function IntegrationOAuthCallback() {
  const { session } = useAuth(),
    action = useAction();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const [done, setDone] = useState(false);
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  if (
    !session ||
    session.user.role === 'SUPER_ADMIN' ||
    ![session.user.role, ...(session.user.roles ?? [])].includes('HR_ADMIN')
  )
    return <h1>Not authorized</h1>;
  return (
    <>
      <h1>Complete provider connection</h1>
      {params.get('error') || !params.get('code') || !params.get('state') ? (
        <p role="alert">
          Authorization was declined or the callback is incomplete. Start again
          from Integrations.
        </p>
      ) : done ? (
        <p role="status">
          Account connected. Return to Integrations to test and enable it.{' '}
          <button onClick={() => window.close()}>
            Close authorization window
          </button>
        </p>
      ) : (
        <>
          <p>Save the authorized account to your organization.</p>
          <button
            disabled={action.busy}
            onClick={async () => {
              const result = await action.run(
                base + '/oauth/complete',
                'POST',
                { state: params.get('state'), code: params.get('code') },
              );
              if (result) {
                setDone(true);
                if (typeof BroadcastChannel !== 'undefined') {
                  const channel = new BroadcastChannel(
                    'hireai-provider-connection',
                  );
                  channel.postMessage({ completed: true });
                  channel.close();
                }
              }
            }}
          >
            Complete connection
          </button>
        </>
      )}
      <Feedback action={action} />
      <Link to="/integrations">Back to integrations</Link>
    </>
  );
}
