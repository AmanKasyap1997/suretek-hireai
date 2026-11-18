import { LinkedInPublishing, LinkedInPartnerSetup } from './LinkedInPublishing';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { AIProviderSetup } from './AIProviderSetup';
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
  oauthSetup?: {
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
    encryptionConfigured: boolean;
    redirectUri: string | null;
  };
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
  oauth2: 'Authorization window',
  oauth_client_credentials: 'OAuth client credentials',
  oauth_refresh_token: 'OAuth refresh token',
  smtp: 'SMTP',
  basic: 'Username and password',
};
const label = (s: string) =>
  labels[s] ?? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
function connectionStatus(connection: Connection) {
  if (connection.credential_hint === 'Disconnected')
    return { text: 'Disconnected', tone: 'neutral' };
  if (connection.status === 'ok')
    return { text: 'Connected · verified', tone: 'success' };
  if (connection.status === 'enabled')
    return { text: 'Connected · enabled', tone: 'success' };
  if (connection.status === 'failing')
    return { text: 'Connected · check needed', tone: 'warning' };
  if (connection.status === 'disabled')
    return { text: 'Connected · provider disabled', tone: 'warning' };
  return { text: 'Connected · verification needed', tone: 'warning' };
}
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
          : result?.authorizationUrl
            ? 'Continue in the provider authorization window.'
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
              <p>Connection methods: {p.methods.map(label).join(', ')}</p>
              <AIProviderSetup provider={p.provider} platform />
              {p.oauthSetup && (
                <details>
                  <summary>Google authorization setup</summary>
                  <p>
                    Configure this once for HireAI. Organization admins then
                    choose their Google account and approve Calendar access.
                  </p>
                  <ol>
                    <li>
                      In Google Cloud, enable Google Calendar API and configure
                      Google Auth Platform branding, audience and Calendar
                      scopes. Add test users while the app is in testing.
                    </li>
                    <li>
                      Create an OAuth client of type Web application and
                      register this exact redirect URI:{' '}
                      <code>
                        {p.oauthSetup.redirectUri ??
                          'Set PUBLIC_WEB_BASE_URL on the backend first.'}
                      </code>
                    </li>
                    <li>
                      Set <code>OAUTH_GOOGLE_CALENDAR_CLIENT_ID</code> and{' '}
                      <code>OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET</code> in the
                      backend environment, then restart it.
                    </li>
                  </ol>
                  <p>
                    Client ID:{' '}
                    {p.oauthSetup.clientIdConfigured ? 'Configured' : 'Missing'}
                    . Client secret:{' '}
                    {p.oauthSetup.clientSecretConfigured
                      ? 'Configured'
                      : 'Missing'}
                    . Secure integration storage:{' '}
                    {p.oauthSetup.encryptionConfigured
                      ? 'Configured'
                      : 'Missing or invalid INTEGRATION_ENCRYPTION_KEY'}
                    .
                  </p>
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Google Cloud credentials
                  </a>
                </details>
              )}
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
  initialMethod,
  onClose,
}: {
  provider: Provider;
  initialMethod: string;
  onClose: () => void;
}) {
  const [method, setMethod] = useState(initialMethod),
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
            Authorization requires platform setup. Contact your platform
            administrator to enable this connection method.
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
    [selected, setSelected] = useState<{
      provider: string;
      method: string;
    } | null>(null);
  const provider = providers.data?.find(
    (p) => p.provider === selected?.provider,
  );
  const [oauthEnvironment, setOAuthEnvironment] = useState('sandbox');
  async function authorize(p: Provider) {
    const popup = window.open(
      'about:blank',
      'hireai-provider',
      'popup,width=620,height=760',
    );
    if (popup) popup.opener = null;
    const result = await action.run(base + '/oauth/start', 'POST', {
      provider: p.provider,
      environment: oauthEnvironment,
      method: 'oauth2',
      credentials: {},
    });
    if (result?.authorizationUrl) {
      if (popup) popup.location.replace(result.authorizationUrl);
      else window.location.assign(result.authorizationUrl);
    } else popup?.close();
  }
  return (
    <>
      <h1>Integrations</h1>
      {providers.data?.some((p) => p.methods.includes('oauth2')) && (
        <label>
          Authorization environment
          <select
            value={oauthEnvironment}
            onChange={(e) => setOAuthEnvironment(e.target.value)}
          >
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </label>
      )}
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
              {providers.data.map((p) => {
                const providerConnections = connections.data.filter(
                  (connection) => connection.provider === p.provider,
                );
                return (
                  <article className="integration-card" key={p.provider}>
                    <div className="integration-card-heading">
                      <h2>{p.label}</h2>
                      {providerConnections.length > 0 && (
                        <div
                          className="integration-status-list"
                          role="group"
                          aria-label={`${p.label} connection status`}
                        >
                          {providerConnections.map((connection) => {
                            const status = connectionStatus(connection);
                            return (
                              <span
                                className={`integration-status integration-status-${status.tone}`}
                                key={connection.id}
                              >
                                {label(connection.environment)} · {status.text}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {p.platformManaged ? (
                      <p>{p.setupMessage}</p>
                    ) : (
                      <>
                        <p>Connect using {p.methods.map(label).join(' or ')}.</p>
                        <div className="integration-actions">
                          {p.methods.map((method) => (
                            <button
                              key={method}
                              disabled={action.busy}
                              onClick={() => {
                                if (
                                  method === 'oauth2' &&
                                  p.oauthReady &&
                                  p.hostedOAuth
                                )
                                  void authorize(p);
                                else
                                  setSelected({
                                    provider: p.provider,
                                    method,
                                  });
                              }}
                            >
                              {method === 'oauth2'
                                ? `Authorize ${p.label}`
                                : p.methods.length === 1
                                  ? `Connect ${p.label}`
                                  : `Use ${label(method)}`}
                            </button>
                          ))}
                        </div>
                        {p.setupMessage && <p>{p.setupMessage}</p>}
                        <AIProviderSetup provider={p.provider} />
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {provider && selected && (
            <ConnectionForm
              key={provider.provider + ':' + selected.method}
              provider={provider}
              initialMethod={selected.method}
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
                  <p>
                    Status:{' '}
                    {c.status === 'ok' ? 'Connected (verified)' : c.status}
                  </p>
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
  const { session, status, retry } = useAuth();
  const cache = useQueryClient();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const started = useRef(false);
  const owner = useRef<string | null>(null);
  const identity = session
    ? `${session.user.tenant_id}:${session.user.id}`
    : null;
  const accountChanged =
    !!owner.current && !!identity && owner.current !== identity;
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const allowed =
    !!session &&
    !session.user.must_change_password &&
    session.user.role !== 'SUPER_ADMIN' &&
    [session.user.role, ...(session.user.roles ?? [])].includes('HR_ADMIN');
  const invalid =
    params.has('error') || !params.get('code') || !params.get('state');
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname,
    );
  }, []);
  useEffect(() => {
    if (status !== 'ready' || !allowed || invalid || started.current) return;
    started.current = true;
    owner.current = identity;
    void (async () => {
      try {
        const connection = await api<{ id: string }>(base + '/oauth/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: params.get('state'),
            code: params.get('code'),
          }),
        });
        let verified = false;
        try {
          const check = await api<{ ok: boolean }>(
            base + '/' + connection.id + '/test',
            { method: 'POST' },
          );
          verified = check.ok;
        } catch {
          /* The authorization is saved even if verification fails. */
        }
        setResult(
          verified
            ? 'Connected and verified. You can now enable this connection in Integrations.'
            : 'Account connected, but verification failed. Return to Integrations to test the connection.',
        );
        await cache.invalidateQueries({
          queryKey: ['organization-integrations'],
        });
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel('hireai-provider-connection');
          channel.postMessage({ completed: true });
          channel.close();
        }
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : 'Authorization failed. Start again from Integrations.',
        );
      }
    })();
  }, [status, allowed, identity, invalid, params, cache]);
  if (status === 'loading') return <p role="status">Loading your session…</p>;
  if (status === 'error')
    return (
      <main className="standalone">
        <h1>Unable to load your session</h1>
        <p>
          Your authorization is still held in this window. Retry the session
          check to continue.
        </p>
        <button onClick={retry}>Try again</button>
      </main>
    );
  if (!session)
    return (
      <main className="standalone">
        <h1>Sign in to connect your provider</h1>
        <p>
          Your HireAI session has expired. Sign in and start a new authorization
          from Integrations.
        </p>
        <Link to="/login">Sign in</Link>
      </main>
    );
  if (accountChanged)
    return (
      <main className="standalone">
        <h1>Signed-in account changed</h1>
        <p>Start a new authorization for the current organization.</p>
        <Link to="/integrations">Back to integrations</Link>
      </main>
    );
  if (!allowed)
    return (
      <main className="standalone">
        <h1>Not authorized</h1>
        <Link to="/">Return to your workspace</Link>
      </main>
    );
  return (
    <main className="standalone">
      <h1>Provider connection</h1>
      {invalid ? (
        <p role="alert">
          {params.get('error') === 'access_denied'
            ? 'Authorization was declined. Start again from Integrations if you want to connect.'
            : params.has('error')
              ? 'The provider could not complete authorization. Start again from Integrations.'
              : 'Authorization details are missing or this callback has already been opened. Start a new connection from Integrations.'}
        </p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : result ? (
        <div>
          <p role="status">{result}</p>
          <button onClick={() => window.close()}>
            Close authorization window
          </button>
        </div>
      ) : (
        <p role="status">Connecting and verifying your account…</p>
      )}
      <Link to="/integrations">Back to integrations</Link>
    </main>
  );
}
