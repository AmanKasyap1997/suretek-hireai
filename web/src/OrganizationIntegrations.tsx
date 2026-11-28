import { LinkedInPublishing, LinkedInPartnerSetup } from './LinkedInPublishing';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AiCallingSettings, AiScreeningSettings } from './AiScreeningSettings';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faArrowUpRightFromSquare,
  faBriefcase,
  faCalendarDays,
  faCircleInfo,
  faCode,
  faEllipsisVertical,
  faEnvelope,
  faFileSignature,
  faFlask,
  faLayerGroup,
  faLink,
  faListCheck,
  faLock,
  faPhone,
  faPlug,
  faPlus,
  faRocket,
  faToggleOn,
  faUsers,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import logo from './assets/suretek-logo.png';
import { api } from './api';
import { useAuth } from './auth';
import { AIProviderSetup } from './AIProviderSetup';
import { InterviewCalendarSetting } from './Interviews';
import { GoogleLogo, heroLogos, providerLogos } from './ProviderLogos';
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
  account_token: 'Auth ID and Auth Token',
  authId: 'Auth ID',
  authToken: 'Auth Token',
  phoneNumber: 'Caller number',
};
const label = (s: string) =>
  labels[s] ?? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
type Status = { text: string; tone: Tone; help: string };
const isDisconnected = (connection: Connection) =>
  connection.credential_hint === 'Disconnected';
/** Each status says what it means and what to do next. */
function connectionStatus(connection: Connection): Status {
  if (isDisconnected(connection))
    return {
      text: 'Disconnected',
      tone: 'neutral',
      help: 'Credentials were removed. Reconnect to use this environment again.',
    };
  switch (connection.status) {
    case 'enabled':
      return { text: 'Active', tone: 'success', help: 'In use by HireAI.' };
    case 'ok':
      return {
        text: 'Verified',
        tone: 'info',
        help: 'The test passed. Enable this connection to start using it.',
      };
    case 'failing':
      return {
        text: 'Test failed',
        tone: 'danger',
        help: 'Check the credentials with the provider, then test again.',
      };
    case 'disabled':
      return {
        text: 'Provider disabled',
        tone: 'neutral',
        help: 'Suretek has turned this provider off, so testing and enabling are paused.',
      };
    default:
      return {
        text: 'Not tested',
        tone: 'warning',
        help: 'Test the connection before you enable it.',
      };
  }
}
/** Card-level summary; worded differently from row statuses on purpose. */
function providerStatus(list: Connection[]): { text: string; tone: Tone } {
  const live = list.filter((connection) => !isDisconnected(connection));
  if (live.some((c) => c.status === 'enabled'))
    return { text: 'In use', tone: 'success' };
  if (live.some((c) => c.status === 'failing'))
    return { text: 'Needs attention', tone: 'danger' };
  if (live.some((c) => c.status === 'ok'))
    return { text: 'Ready to enable', tone: 'info' };
  if (live.length) return { text: 'Awaiting test', tone: 'warning' };
  return { text: 'Not connected', tone: 'neutral' };
}
type Category = {
  id: string;
  title: string;
  description: string;
  icon: IconDefinition;
  providers: string[];
};
const categories: Category[] = [
  {
    id: 'ai',
    title: 'AI providers',
    description:
      'Draft job descriptions and power AI-assisted hiring with your organization’s own keys.',
    icon: faWandMagicSparkles,
    providers: ['openai', 'anthropic', 'google_ai'],
  },
  {
    id: 'calendar',
    title: 'Calendars',
    description: 'Check interviewer availability and book interviews.',
    icon: faCalendarDays,
    providers: ['google_calendar', 'microsoft_calendar'],
  },
  {
    id: 'communication',
    title: 'Communication',
    description:
      'Email candidates and interviewers, and place screening calls.',
    icon: faEnvelope,
    providers: ['email', 'plivo', 'telephony'],
  },
  {
    id: 'publishing',
    title: 'Careers & job boards',
    description: 'Publish approved openings to your careers site and LinkedIn.',
    icon: faBriefcase,
    providers: ['careers_cms', 'linkedin', 'linkedin_profile', 'linkedin_jobs'],
  },
  {
    id: 'records',
    title: 'Documents & HR systems',
    description:
      'Send offers for signature and sync hires with your HR system.',
    icon: faFileSignature,
    providers: ['e_signature', 'hris'],
  },
];
const otherCategory: Category = {
  id: 'other',
  title: 'Other services',
  description: 'Additional services enabled by Suretek.',
  icon: faPlug,
  providers: [],
};
/** Shorter names for the filter tabs. */
const tabLabels: Record<string, string> = {
  ai: 'AI providers',
  calendar: 'Calendars',
  communication: 'Communication',
  publishing: 'Job boards',
  records: 'Documents & HR',
  other: 'Other',
};
const categoryOf = (provider: string) =>
  categories.find((c) => c.providers.includes(provider)) ?? otherCategory;
const providerInfo: Record<
  string,
  { name: string; description: string; keyUrl?: string; keyLabel?: string }
> = {
  openai: {
    name: 'OpenAI',
    description: 'Drafts job descriptions with your OpenAI API key.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'Create an OpenAI API key',
  },
  anthropic: {
    name: 'Anthropic',
    description: 'Drafts job descriptions with Claude and your Anthropic key.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyLabel: 'Create an Anthropic API key',
  },
  google_ai: {
    name: 'Google AI Studio (Gemini)',
    description:
      'Drafts job descriptions with Gemini. Google AI Studio has a free usage tier.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Create a Google AI Studio API key',
  },
  google_calendar: {
    name: 'Google Calendar',
    description: 'Checks availability and books interview events.',
  },
  microsoft_calendar: {
    name: 'Microsoft Calendar',
    description: 'Checks availability and books interviews in Outlook.',
  },
  email: {
    name: 'Email',
    description:
      'Sends candidate and interviewer emails for your organization.',
  },
  telephony: {
    name: 'Telephony',
    description: 'Places consent-based AI screening calls.',
  },
  plivo: {
    name: 'Plivo',
    description:
      'Phones candidates for AI calls from your organization’s Plivo number.',
    keyUrl: 'https://console.plivo.com/dashboard/',
    keyLabel: 'Find your Auth ID and Auth Token in the Plivo console',
  },
  careers_cms: {
    name: 'Careers CMS / API',
    description: 'Publishes approved jobs to your careers website.',
  },
  linkedin: {
    name: 'LinkedIn company pages',
    description: 'Shares published jobs on your LinkedIn company page.',
  },
  linkedin_profile: {
    name: 'LinkedIn profile',
    description:
      'Shares published jobs on the personal LinkedIn profile of the admin who connects it.',
  },
  linkedin_jobs: {
    name: 'LinkedIn Jobs',
    description:
      'Lists jobs on LinkedIn Jobs through Suretek’s partner access.',
  },
  e_signature: {
    name: 'E-signature',
    description: 'Sends offer letters for electronic signature.',
  },
  hris: {
    name: 'HRIS',
    description: 'Keeps hired candidates in sync with your HR system.',
  },
};
const providerName = (id: string) => providerInfo[id]?.name ?? label(id);

/**
 * A provider's tile: its logo (see ProviderLogos), or else its initial or a
 * matching icon in colours that hint at the brand.
 */
const marks: Record<
  string,
  { text?: string; icon?: IconDefinition; tone: string }
> = {
  email: { icon: faEnvelope, tone: 'brand' },
  telephony: { icon: faPhone, tone: 'brand' },
  plivo: { text: 'P', tone: 'green' },
  careers_cms: { icon: faCode, tone: 'brand' },
  linkedin: { text: 'in', tone: 'linkedin' },
  linkedin_profile: { text: 'in', tone: 'linkedin' },
  linkedin_jobs: { text: 'in', tone: 'linkedin' },
  e_signature: { icon: faFileSignature, tone: 'brand' },
  hris: { icon: faUsers, tone: 'brand' },
};
function ProviderMark({
  provider,
  hero = false,
}: {
  provider: string;
  /** In the page's header art, which shows company logos. */
  hero?: boolean;
}) {
  const logo = (hero ? heroLogos : providerLogos)[provider];
  if (logo)
    return (
      <span
        className={`int-mark int-mark-logo${logo.fill ? ' int-mark-logo-fill' : ''}`}
        aria-hidden="true"
      >
        <logo.Svg />
      </span>
    );
  const mark = marks[provider] ?? {
    icon: categoryOf(provider).icon,
    tone: 'brand',
  };
  return (
    <span className={`int-mark int-mark-${mark.tone}`} aria-hidden="true">
      {mark.icon ? <FontAwesomeIcon icon={mark.icon} /> : mark.text}
    </span>
  );
}

/**
 * Decorative: HireAI in the middle, connected to the organization's
 * services. The first six fill the spots in order: left, top left, bottom
 * left, top right, right, bottom right.
 */
const artOrder = [
  'google_ai',
  'openai',
  'google_calendar',
  'linkedin',
  'microsoft_calendar',
  'plivo',
  'telephony',
  'email',
  'anthropic',
];
const artCenter = [50, 54];
const artSpots = [
  [7, 45],
  [26, 21],
  [25, 79],
  [73, 21],
  [93, 45],
  [74, 79],
];
/** One tile per company: LinkedIn's three integrations share a logo. */
const artFamily = (provider: string) =>
  provider.startsWith('linkedin') ? 'linkedin' : provider;
function HeroArt({ providers }: { providers: string[] }) {
  const shown = [
    ...artOrder.filter((p) => providers.includes(p)),
    ...providers.filter((p) => !artOrder.includes(p)),
  ]
    .filter(
      (p, index, all) =>
        all.findIndex((other) => artFamily(other) === artFamily(p)) === index,
    )
    .slice(0, 6);
  if (!shown.length) return null;
  const [cx, cy] = artCenter;
  return (
    <div className="int-hero-art" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        {shown.map((p, index) => {
          const [x, y] = artSpots[index];
          const mid = (x + cx) / 2;
          // Leaves the centre and reaches the tile level: a soft S-curve.
          return (
            <path
              key={p}
              d={`M${cx} ${cy} C ${mid} ${cy} ${mid} ${y} ${x} ${y}`}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <span className="int-hero-center">
        <img src={logo} alt="" />
      </span>
      {shown.map((p, index) => (
        <span
          key={p}
          className="int-hero-spot"
          style={{
            left: `${artSpots[index][0]}%`,
            top: `${artSpots[index][1]}%`,
          }}
        >
          <ProviderMark provider={p} hero />
        </span>
      ))}
    </div>
  );
}

type MenuItem = { text: string; onSelect: () => void; danger?: boolean };
/** A "⋮" menu for a connection's less frequent actions. */
function MoreActions({
  label: name,
  items,
  disabled,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="int-more" ref={box}>
      <button
        ref={button}
        type="button"
        className="int-more-button"
        aria-label={name}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <FontAwesomeIcon icon={faEllipsisVertical} aria-hidden="true" />
      </button>
      {open && (
        <div className="int-more-menu">
          {items.map((item) => (
            <button
              key={item.text}
              type="button"
              className={item.danger ? 'int-danger-button' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const environments = ['sandbox', 'production'];
const verifiedOn = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
const verifiedAt = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
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
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      {action.message && (
        <p
          className={
            action.message.startsWith('Connection verification failed')
              ? 'form-error'
              : 'form-success'
          }
          role="status"
        >
          {action.message}
        </p>
      )}
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
type Selection = { provider: string; method: string; environment: string };
const steps: [string, string, IconDefinition][] = [
  ['Connect sandbox', 'Add test credentials for the provider.', faLink],
  ['Test', 'HireAI checks the credentials with the provider.', faFlask],
  ['Enable', 'Turn on a verified connection to start using it.', faToggleOn],
  ['Go live', 'Repeat with production credentials when ready.', faRocket],
];
const isSecret = (field: string) =>
  !['username', 'clientId', 'scope', 'authId', 'phoneNumber'].includes(field);
function ConnectionForm({
  provider,
  initialMethod,
  initialEnvironment,
  onClose,
}: {
  provider: Provider;
  initialMethod: string;
  initialEnvironment: string;
  onClose: () => void;
}) {
  const [method, setMethod] = useState(initialMethod),
    [saved, setSaved] = useState(false),
    action = useAction(),
    id = useId(),
    heading = useRef<HTMLHeadingElement>(null);
  const info = providerInfo[provider.provider];
  useEffect(() => {
    // Bring the form into view next to the card the admin clicked.
    heading.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="int-form-panel" aria-labelledby={id + 'title'}>
      <div className="int-form-header">
        <div>
          <h4 id={id + 'title'} ref={heading} tabIndex={-1}>
            Connect {provider.label}
          </h4>
          <p>
            <FontAwesomeIcon icon={faLock} aria-hidden="true" /> Credentials are
            encrypted, used only for your organization and never shown again
            after saving.
          </p>
        </div>
        <button
          type="button"
          className="int-icon-button"
          aria-label="Close connection form"
          disabled={action.busy}
          onClick={onClose}
        >
          <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
        </button>
      </div>
      <form
        className="int-form"
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
          const result = await action.run(
            base + (method === 'oauth2' ? '/oauth/start' : ''),
            'POST',
            {
              provider: provider.provider,
              environment: values.get('environment'),
              method,
              credentials,
            },
          );
          if (result?.authorizationUrl) {
            if (popup) popup.location.replace(result.authorizationUrl);
            else window.location.assign(result.authorizationUrl);
          } else {
            popup?.close();
            if (result) {
              form.reset();
              setSaved(true);
            }
          }
        }}
      >
        <div className="int-form-grid">
          <div className="int-field">
            <label htmlFor={id + 'environment'}>Environment</label>
            <select
              id={id + 'environment'}
              name="environment"
              defaultValue={initialEnvironment}
              aria-describedby={id + 'environment-help'}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
            <small id={id + 'environment-help'}>
              Start with sandbox. Production can be enabled after sandbox passes
              its test.
            </small>
          </div>
          {provider.methods.length > 1 && (
            <div className="int-field">
              <label htmlFor={id + 'method'}>Connection method</label>
              <select
                id={id + 'method'}
                value={method}
                onChange={(e) => {
                  setMethod(e.target.value);
                  setSaved(false);
                }}
              >
                {provider.methods.map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {provider.fields[method].length > 0 && (
          <div className="int-form-grid" key={method}>
            {provider.fields[method].map((field) => (
              <div className="int-field" key={field}>
                <label htmlFor={id + field}>{label(field)}</label>
                <input
                  id={id + field}
                  name={field}
                  type={
                    isSecret(field)
                      ? 'password'
                      : field === 'phoneNumber'
                        ? 'tel'
                        : 'text'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  required={field !== 'scope'}
                  minLength={isSecret(field) ? 8 : 1}
                  maxLength={8192}
                  {...(field === 'phoneNumber'
                    ? {
                        pattern: '\\+[1-9][0-9]{7,14}',
                        placeholder: '+918045671234',
                        'aria-describedby': id + field + '-hint',
                      }
                    : {})}
                  onInput={() => setSaved(false)}
                />
                {field === 'phoneNumber' && (
                  <small id={id + field + '-hint'}>
                    A number you rent in Plivo, in international format.
                    Candidates see it when HireAI calls.
                  </small>
                )}
                {(field === 'apiKey' || field === 'authId') && info?.keyUrl && (
                  <small>
                    <a
                      href={info.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {info.keyLabel}{' '}
                      <FontAwesomeIcon
                        icon={faArrowUpRightFromSquare}
                        aria-hidden="true"
                      />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </small>
                )}
              </div>
            ))}
          </div>
        )}
        {method === 'oauth2' && provider.hostedOAuth && (
          <p className="int-note">
            You will sign in and approve access on {provider.label}’s website.
            HireAI does not ask for your provider password.
          </p>
        )}
        {method === 'oauth2' && !provider.hostedOAuth && (
          <p className="int-note int-note-warning">
            Authorization requires platform setup. Contact your platform
            administrator to enable this connection method.
          </p>
        )}
        {method === 'oauth2' && provider.setupMessage && (
          <p className="int-note int-note-warning" role="status">
            {provider.setupMessage}
          </p>
        )}
        {method === 'smtp' && (
          <p className="int-note">
            The platform operator configures the trusted SMTP server. Enter your
            organization’s SMTP credentials.
          </p>
        )}
        <div className="int-form-actions">
          <button
            className="button-primary"
            disabled={
              action.busy ||
              (method === 'oauth2' && provider.oauthReady === false)
            }
          >
            {method === 'oauth2' &&
              !action.busy &&
              provider.provider === 'google_calendar' && (
                <span className="int-button-logo" aria-hidden="true">
                  <GoogleLogo />
                </span>
              )}
            {action.busy
              ? 'Saving…'
              : method === 'oauth2'
                ? 'Connect with ' + provider.label
                : 'Save connection'}
          </button>
          <button type="button" disabled={action.busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
      <Feedback action={action} />
      {saved && (
        <p className="int-next">
          <strong>Next:</strong> select <strong>Test connection</strong> for
          this environment, then <strong>Enable connection</strong> once the
          test passes.
        </p>
      )}
    </section>
  );
}
function ConnectionRow({
  connection: c,
  busy,
  run,
  onUpdate,
  extra = [],
}: {
  connection: Connection;
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  onUpdate?: () => void;
  /** More menu items, such as adding the other environment. */
  extra?: MenuItem[];
}) {
  const status = connectionStatus(c),
    id = useId(),
    disconnected = isDisconnected(c);
  return (
    <li className="int-env-row">
      <div className="int-env-main">
        <div className="int-env-title">
          <strong id={id}>{label(c.environment)}</strong>
          <span className={`int-pill int-pill-${status.tone}`}>
            {status.text}
          </span>
          <MoreActions
            label={`More actions for ${providerName(c.provider)} ${c.environment}`}
            disabled={busy}
            items={[
              ...extra,
              ...(disconnected
                ? []
                : [
                    {
                      text: 'Disconnect',
                      danger: true,
                      onSelect: () => {
                        if (
                          window.confirm(
                            `Disconnect the ${c.environment} ${providerName(c.provider)} connection and remove its credentials?`,
                          )
                        )
                          void run(`${base}/${c.id}`, 'DELETE');
                      },
                    },
                  ]),
            ]}
          />
        </div>
        <p className="int-env-detail">
          <span>
            {label(c.method)}
            {disconnected ? '' : ` ${c.credential_hint}`}
          </span>
          <span
            title={
              c.last_verified_at ? verifiedAt(c.last_verified_at) : undefined
            }
          >
            {c.last_verified_at
              ? `Verified ${verifiedOn(c.last_verified_at)}`
              : 'Not verified yet'}
          </span>
        </p>
        {/* "In use by HireAI" repeats the Active pill, so it's for screen readers. */}
        <p
          className={
            c.status === 'enabled' && !disconnected
              ? 'int-env-help sr-only'
              : 'int-env-help'
          }
          id={id + 'help'}
        >
          {status.help}
        </p>
      </div>
      <div className="int-env-actions">
        {disconnected ? (
          onUpdate && (
            <button type="button" disabled={busy} onClick={onUpdate}>
              Reconnect
            </button>
          )
        ) : c.status === 'disabled' ? null : (
          <>
            <button
              type="button"
              className={
                ['ok', 'enabled'].includes(c.status)
                  ? undefined
                  : 'button-primary'
              }
              disabled={busy}
              aria-describedby={id}
              onClick={() => void run(`${base}/${c.id}/test`, 'POST')}
            >
              Test connection
            </button>
            {c.status !== 'enabled' && (
              <button
                type="button"
                className={c.status === 'ok' ? 'button-primary' : undefined}
                disabled={busy || c.status !== 'ok'}
                title={
                  c.status === 'ok'
                    ? undefined
                    : 'Test this connection successfully first'
                }
                aria-describedby={id + 'help'}
                onClick={() => void run(`${base}/${c.id}/enable`, 'POST')}
              >
                Enable connection
              </button>
            )}
            {onUpdate && (
              <button type="button" disabled={busy} onClick={onUpdate}>
                {c.method === 'oauth2' ? 'Reauthorize' : 'Update credentials'}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
function ProviderCard({
  provider: p,
  connections: list,
  selection,
  onSelect,
  onClose,
}: {
  provider: Provider;
  connections: Connection[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}) {
  const action = useAction(),
    id = useId();
  const status = providerStatus(list);
  const manual = p.methods.filter((m) => m !== 'oauth2');
  const oauth = p.methods.includes('oauth2');
  const canAuthorize = oauth && !!p.hostedOAuth && !!p.oauthReady;
  const rows = environments.flatMap((env) =>
    list.filter((c) => c.environment === env),
  );
  // Disconnected rows offer their own Reconnect action.
  const missing = environments.filter(
    (env) => !list.some((c) => c.environment === env),
  );
  const open = selection?.provider === p.provider;
  const canAdd = !p.platformManaged && (canAuthorize || manual.length > 0);
  async function authorize(environment: string) {
    const popup = window.open(
      'about:blank',
      'hireai-provider',
      'popup,width=620,height=760',
    );
    if (popup) popup.opener = null;
    const result = await action.run(base + '/oauth/start', 'POST', {
      provider: p.provider,
      environment,
      method: 'oauth2',
      credentials: {},
    });
    if (result?.authorizationUrl) {
      if (popup) popup.location.replace(result.authorizationUrl);
      else window.location.assign(result.authorizationUrl);
    } else popup?.close();
  }
  function connect(environment: string, method?: string) {
    const chosen =
      method ?? (canAuthorize ? 'oauth2' : (manual[0] ?? 'oauth2'));
    if (chosen === 'oauth2' && canAuthorize) void authorize(environment);
    else onSelect({ provider: p.provider, environment, method: chosen });
  }
  return (
    <article
      className={open ? 'int-card is-open' : 'int-card'}
      aria-labelledby={id}
    >
      <header className="int-card-header">
        <ProviderMark provider={p.provider} />
        <div>
          <div className="int-card-title">
            <h3 id={id}>{p.label}</h3>
            <span className={`int-pill int-pill-${status.tone}`}>
              {status.text}
            </span>
          </div>
          {providerInfo[p.provider] && (
            <p>{providerInfo[p.provider].description}</p>
          )}
        </div>
      </header>
      {rows.length > 0 && (
        <ul className="int-env-list" aria-label={`${p.label} connections`}>
          {rows.map((c, index) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              busy={action.busy}
              run={action.run}
              onUpdate={
                p.platformManaged
                  ? undefined
                  : () => connect(c.environment, c.method)
              }
              extra={
                index === rows.length - 1 && canAdd && missing.length
                  ? [
                      {
                        text: `Add ${missing[0]} connection`,
                        onSelect: () => connect(missing[0]),
                      },
                    ]
                  : []
              }
            />
          ))}
        </ul>
      )}
      {p.platformManaged ? (
        <p className="int-note">
          <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />{' '}
          {p.setupMessage}
        </p>
      ) : (
        <>
          {oauth && !canAuthorize && (
            <div className="int-note">
              <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" /> Sign-in
              authorization isn’t set up by Suretek yet.
              {manual.length
                ? ' You can connect with credentials instead.'
                : ' Contact your platform administrator.'}
              {p.setupMessage && (
                <details>
                  <summary>Details for your platform administrator</summary>
                  <p>{p.setupMessage}</p>
                </details>
              )}
            </div>
          )}
          {!open && canAdd && missing.length === environments.length && (
            <div className="int-card-actions">
              {canAuthorize && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={action.busy}
                  onClick={() => void authorize('sandbox')}
                >
                  {p.provider === 'google_calendar' && (
                    <span className="int-button-logo" aria-hidden="true">
                      <GoogleLogo />
                    </span>
                  )}
                  Authorize {p.label}
                </button>
              )}
              {manual.length > 0 && (
                <button
                  type="button"
                  className={canAuthorize ? undefined : 'button-primary'}
                  disabled={action.busy}
                  onClick={() =>
                    onSelect({
                      provider: p.provider,
                      environment: 'sandbox',
                      method: manual[0],
                    })
                  }
                >
                  {canAuthorize
                    ? 'Use credentials instead'
                    : `Connect ${p.label}`}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <Feedback action={action} />
      {open && selection && (
        <ConnectionForm
          key={selection.environment + ':' + selection.method}
          provider={p}
          initialMethod={selection.method}
          initialEnvironment={selection.environment}
          onClose={onClose}
        />
      )}
    </article>
  );
}
function UnavailableCard({
  provider,
  connections: list,
}: {
  provider: string;
  connections: Connection[];
}) {
  const action = useAction(),
    id = useId();
  return (
    <article className="int-card" aria-labelledby={id}>
      <header className="int-card-header">
        <ProviderMark provider={provider} />
        <div>
          <h3 id={id}>{providerName(provider)}</h3>
          <p>Paused by Suretek.</p>
        </div>
      </header>
      <ul
        className="int-env-list"
        aria-label={`${providerName(provider)} connections`}
      >
        {environments
          .flatMap((env) => list.filter((c) => c.environment === env))
          .map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              busy={action.busy}
              run={action.run}
            />
          ))}
      </ul>
      <Feedback action={action} />
    </article>
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
    [selected, setSelected] = useState<Selection | null>(null);
  const providerList = providers.data ?? [],
    connectionList = connections.data ?? [];
  const forProvider = (provider: string) =>
    connectionList.filter((c) => c.provider === provider);
  const available = new Set(providerList.map((p) => p.provider));
  const unavailable = [
    ...new Set(
      connectionList
        .filter((c) => !available.has(c.provider))
        .map((c) => c.provider),
    ),
  ];
  const summaries = providerList.map((p) =>
    providerStatus(forProvider(p.provider)),
  );
  const attention = summaries.filter((s) => s.tone === 'danger').length;
  const groups = [...categories, otherCategory]
    .map((category) => ({
      category,
      items: providerList.filter(
        (p) => categoryOf(p.provider).id === category.id,
      ),
    }))
    .filter((group) => group.items.length > 0);
  const ready = providers.isSuccess && connections.isSuccess;
  const hiring = !!session?.user.enabled_modules?.includes('hiring');
  const linkedIn = providerList.some(
    (p) => p.provider === 'linkedin' || p.provider === 'linkedin_jobs',
  );
  // Filters: every category, plus the AI hiring tools after AI providers.
  const [tab, setTab] = useState('all');
  const tabs: {
    id: string;
    label: string;
    icon: IconDefinition;
    count: number;
  }[] = [
    {
      id: 'all',
      label: 'All integrations',
      icon: faLayerGroup,
      count: providerList.length,
    },
    ...groups.flatMap(({ category, items }) => [
      {
        id: category.id,
        label: tabLabels[category.id] ?? category.title,
        icon: category.icon,
        count: items.length,
      },
      ...(category.id === 'ai' && hiring
        ? [
            {
              id: 'ai-tools',
              label: 'AI hiring tools',
              icon: faListCheck,
              count: 2,
            },
          ]
        : []),
    ]),
  ];
  const shows = (id: string) => tab === 'all' || tab === id;
  const heading = (
    id: string,
    icon: IconDefinition,
    title: string,
    text: string,
  ) => (
    <div className="int-category-heading">
      <span className="icon-tile" aria-hidden="true">
        <FontAwesomeIcon icon={icon} />
      </span>
      <div>
        <h2 id={'integration-category-' + id}>{title}</h2>
        <p>{text}</p>
      </div>
    </div>
  );
  return (
    <section className="integrations-page">
      <header className="int-hero">
        <div className="int-hero-text">
          <p className="eyebrow">ADMINISTRATION</p>
          <h1>Integrations</h1>
          <p className="intro">
            Connect your organization’s accounts to the services enabled by
            Suretek HireAI. Create a seamless hiring experience, powered by
            leading AI and business tools.
          </p>
          {/* Only a warning: what's connected shows on each card. */}
          {ready && attention > 0 && (
            <div className="int-summary" role="group" aria-label="Summary">
              <span className="int-pill int-pill-danger">
                {attention} {attention === 1 ? 'needs' : 'need'} attention
              </span>
            </div>
          )}
        </div>
        <HeroArt providers={providerList.map((p) => p.provider)} />
      </header>
      <ol className="int-steps" aria-label="How connections work">
        {steps.map(([title, text, icon]) => (
          <li key={title}>
            <span className="int-step-icon" aria-hidden="true">
              <FontAwesomeIcon icon={icon} />
            </span>
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
      {providers.isPending || connections.isPending ? (
        <p role="status" className="int-empty">
          Loading integrations…
        </p>
      ) : providers.isError || connections.isError ? (
        <div role="alert" className="int-empty">
          Unable to load integrations.{' '}
          <button
            type="button"
            onClick={() => {
              void providers.refetch();
              void connections.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {providerList.length === 0 ? (
            <div className="int-empty">
              <span className="icon-tile" aria-hidden="true">
                <FontAwesomeIcon icon={faPlug} />
              </span>
              <p>
                No providers are enabled. Contact your platform administrator.
              </p>
            </div>
          ) : (
            <>
              <div
                className="int-tabs"
                role="group"
                aria-label="Show integrations"
              >
                {tabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={tab === item.id}
                    onClick={() => setTab(item.id)}
                  >
                    <FontAwesomeIcon icon={item.icon} aria-hidden="true" />
                    {item.label} <span>({item.count})</span>
                  </button>
                ))}
              </div>
              {groups.map(({ category, items }) => (
                <Fragment key={category.id}>
                  {shows(category.id) && (
                    <section
                      className="int-category"
                      aria-labelledby={'integration-category-' + category.id}
                    >
                      {heading(
                        category.id,
                        category.icon,
                        category.title,
                        category.description,
                      )}
                      {category.id === 'calendar' && hiring && (
                        <InterviewCalendarSetting
                          version={JSON.stringify(
                            connectionList
                              .filter(
                                (c) => categoryOf(c.provider).id === 'calendar',
                              )
                              .map((c) => [c.id, c.status]),
                          )}
                        />
                      )}
                      <div className="int-grid">
                        {items.map((p) => (
                          <ProviderCard
                            key={p.provider}
                            provider={p}
                            connections={forProvider(p.provider)}
                            selection={selected}
                            onSelect={setSelected}
                            onClose={() => setSelected(null)}
                          />
                        ))}
                        {category.id === 'ai' && (
                          <div className="int-card int-card-more">
                            <span
                              className="int-card-more-icon"
                              aria-hidden="true"
                            >
                              <FontAwesomeIcon icon={faPlus} />
                            </span>
                            <strong>Need another AI provider?</strong>
                            <p>
                              Suretek enables AI providers for your
                              organization. Ask your Suretek administrator to
                              add one.
                            </p>
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                  {category.id === 'ai' && hiring && shows('ai-tools') && (
                    <section
                      className="int-category"
                      aria-labelledby="integration-category-ai-tools"
                    >
                      {heading(
                        'ai-tools',
                        faListCheck,
                        'AI hiring tools',
                        'Resume screening and candidate calls, using the AI providers above.',
                      )}
                      <div className="int-grid int-grid-wide">
                        <AiScreeningSettings />
                        <AiCallingSettings />
                      </div>
                    </section>
                  )}
                </Fragment>
              ))}
            </>
          )}
          {unavailable.length > 0 && tab === 'all' && (
            <section
              className="int-category"
              aria-labelledby="integration-category-unavailable"
            >
              {heading(
                'unavailable',
                faPlug,
                'Unavailable providers',
                'Suretek has turned these providers off. Saved connections stay paused until you disconnect them or the provider returns.',
              )}
              <div className="int-grid">
                {unavailable.map((provider) => (
                  <UnavailableCard
                    key={provider}
                    provider={provider}
                    connections={forProvider(provider)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {hiring && linkedIn && (tab === 'all' || tab === 'publishing') && (
        <LinkedInPublishing
          social={providerList.some((p) => p.provider === 'linkedin')}
          jobsEnabled={providerList.some((p) => p.provider === 'linkedin_jobs')}
        />
      )}
    </section>
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
            : params.get('error') === 'unauthorized_scope_error'
              ? // LinkedIn: the app lacks an approved product (its own text isn't shown).
                'The provider hasn’t approved the permissions HireAI asks for. For LinkedIn company pages, LinkedIn must first approve Community Management API access for HireAI’s LinkedIn app. Ask your Suretek administrator, then try again.'
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
