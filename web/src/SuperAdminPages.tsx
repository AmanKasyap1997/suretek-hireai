import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type FormEvent,
  type ComponentProps,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
const base = '/super-admin';
const moduleNames = [
  'hiring',
  'core_hr',
  'leave',
  'attendance',
  'onboarding',
  'payroll',
  'compensation',
  'expenses',
  'offboarding',
  'performance',
  'learning',
  'engagement',
  'helpdesk',
];
type Row = Record<string, unknown>;
type Page = { data: Row[]; pagination: { total: number } };
const label = (v: string) =>
  (
    ({
      adminName: 'First HR Admin name',
      adminEmail: 'First HR Admin email',
      fullName: 'Full name',
      currentPassword: 'Current password',
      organization_id: 'Organization',
      credential_hint: 'Credential',
      max_users: 'Maximum users',
      call_minutes_per_month: 'Monthly call minutes',
      storage_mb: 'Storage (MB)',
      calling_start: 'Calling starts (hour)',
      calling_end: 'Calling ends (hour)',
      call_quota: 'Monthly planned call quota',
      password_min_length: 'Minimum password length',
      session_seconds: 'Session duration (seconds)',
    }) as Record<string, string>
  )[v] ?? v.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
const display = (v: unknown): string =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
function useAction() {
  const cache = useQueryClient();
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return {
    message,
    busy,
    run: async (path: string, method: string, body?: unknown) => {
      setBusy(true);
      setMessage('');
      try {
        const result = await api<Row>(base + path, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        setMessage(
          result?.deliveryStatus === 'FAILED'
            ? 'Saved, but invitation email failed. Check SMTP and resend.'
            : result?.ok === false
              ? 'Connection failed. Check credentials and provider configuration.'
              : 'Saved successfully.',
        );
        await cache.invalidateQueries({ queryKey: ['platform'] });
        return true;
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Request failed.');
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}
function Notice({
  children,
  result = false,
}: {
  children: ReactNode;
  result?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={result ? 'notice result-toast' : 'notice'}
    >
      {children}
      {result && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss notification"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
function Data({
  path,
  children,
}: {
  path: string;
  children: (data: Row) => ReactNode;
}) {
  const q = useQuery({
    queryKey: ['platform', path],
    queryFn: () => api<Row>(base + path),
  });
  if (q.isPending) return <Notice>Loading…</Notice>;
  if (q.isError)
    return (
      <div role="alert">
        Unable to load this page.{' '}
        <button onClick={() => void q.refetch()}>Retry</button>
      </div>
    );
  return <>{children(q.data)}</>;
}
function Table({
  rows,
  columns,
  actions,
}: {
  rows: Row[];
  columns: string[];
  actions?: (row: Row) => ReactNode;
}) {
  if (!rows.length) return <p className="empty-state">No records found.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((k) => (
              <th key={k}>{label(k)}</th>
            ))}
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r.id ?? i)}>
              {columns.map((k) => (
                <td key={k}>{display(r[k])}</td>
              ))}
              {actions && <td className="row-actions">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Pager({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="pagination">
      <span>{total} records</span>
      <button
        disabled={!offset}
        onClick={() => onChange(Math.max(0, offset - 25))}
      >
        Previous
      </button>
      <button
        disabled={offset + 25 >= total}
        onClick={() => onChange(offset + 25)}
      >
        Next
      </button>
    </div>
  );
}
type Field = {
  name: string;
  type?: string;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};
const FormErrors = createContext<Record<string, string>>({});
function PlatformForm({
  onSubmit,
  children,
  ...props
}: ComponentProps<'form'>) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <FormErrors.Provider value={errors}>
      <form
        {...props}
        noValidate
        onSubmit={(e) => {
          const next: Record<string, string> = {};
          for (const field of Array.from(e.currentTarget.elements)) {
            if (!(field instanceof HTMLInputElement)) continue;
            if (!field.validity.valid)
              next[field.name] = field.validationMessage;
            if (field.name === 'timezone') {
              try {
                new Intl.DateTimeFormat('en', { timeZone: field.value });
              } catch {
                next[field.name] =
                  'Enter a valid timezone, for example Asia/Kolkata.';
              }
            }
          }
          setErrors(next);
          if (Object.keys(next).length) {
            e.preventDefault();
            (
              e.currentTarget.elements.namedItem(
                Object.keys(next)[0],
              ) as HTMLElement
            )?.focus();
          } else void onSubmit?.(e);
        }}
      >
        {children}
      </form>
    </FormErrors.Provider>
  );
}
function Fields({ fields, value = {} }: { fields: Field[]; value?: Row }) {
  const errors = useContext(FormErrors);
  return (
    <>
      {fields.map((f) => (
        <label className="form-field" key={f.name}>
          {label(f.name)}
          {f.options ? (
            <select
              name={f.name}
              defaultValue={String(value[f.name] ?? f.options[0])}
            >
              {f.options.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={f.name}
              aria-label={label(f.name)}
              aria-invalid={!!errors[f.name]}
              aria-describedby={errors[f.name] ? `error-${f.name}` : undefined}
              type={f.type ?? 'text'}
              defaultValue={String(value[f.name] ?? '')}
              required={f.required ?? true}
              min={f.min}
              max={f.max}
              minLength={
                f.minLength ?? (f.type === 'password' ? 12 : undefined)
              }
              maxLength={f.maxLength ?? (f.type === 'password' ? 128 : 200)}
              pattern={f.pattern}
              autoComplete={f.type === 'password' ? 'new-password' : undefined}
            />
          )}
          {errors[f.name] && (
            <span role="alert" id={`error-${f.name}`}>
              {errors[f.name]}
            </span>
          )}
        </label>
      ))}
    </>
  );
}
const profileFields: Field[] = [
  { name: 'name' },
  {
    name: 'domain',
    required: false,
    maxLength: 253,
    pattern: '(?:[a-zA-Z0-9](?:[a-zA-Z0-9\\-]*[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}',
  },
  { name: 'country', required: false },
  { name: 'timezone' },
  { name: 'plan' },
  { name: 'status', options: ['active', 'trial'] },
  { name: 'trial_ends_at', type: 'datetime-local', required: false },
];
export function localDateTime(value: unknown) {
  if (!value) return '';
  const date = new Date(String(value));
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function OrganizationForm({
  value = {},
  onSubmit,
  busy,
  creating = false,
}: {
  value?: Row;
  onSubmit: (value: Row) => Promise<boolean>;
  busy: boolean;
  creating?: boolean;
}) {
  const limits = (value.limits ?? {
    max_users: 100,
    call_minutes_per_month: 1000,
    storage_mb: 10240,
  }) as Row;
  const enabled = (value.enabled_modules ??
    moduleNames.slice(0, 5)) as string[];
  return (
    <PlatformForm
      className="platform-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          d = new FormData(form),
          v = Object.fromEntries(d) as Row;
        v.domain = v.domain || null;
        v.trial_ends_at = v.trial_ends_at
          ? new Date(String(v.trial_ends_at)).toISOString()
          : null;
        v.enabled_modules = d.getAll('enabled_modules');
        v.limits = Object.fromEntries(
          Object.keys(limits).map((k) => [k, Number(d.get(k))]),
        );
        Object.keys(limits).forEach((k) => delete v[k]);
        if ((await onSubmit(v)) && creating) form.reset();
      }}
    >
      <div className="platform-fields">
        <Fields
          fields={profileFields}
          value={{
            timezone: 'UTC',
            plan: 'standard',
            ...value,
            status: value.status === 'suspended' ? 'active' : value.status,
            trial_ends_at: value.trial_ends_at
              ? localDateTime(value.trial_ends_at)
              : '',
          }}
        />
        {creating && (
          <Fields
            fields={[
              {
                name: 'slug',
                pattern: '[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]',
                minLength: 3,
                maxLength: 63,
              },
              { name: 'adminName' },
              { name: 'adminEmail', type: 'email' },
            ]}
          />
        )}
        <Fields
          fields={Object.keys(limits).map((name) => ({
            name,
            type: 'number',
            min: name === 'max_users' ? 1 : 0,
          }))}
          value={limits}
        />
      </div>
      <fieldset>
        <legend>Enabled modules</legend>
        <div className="module-options">
          {moduleNames.map((m, i) => (
            <label key={m}>
              <input
                type="checkbox"
                name="enabled_modules"
                value={m}
                defaultChecked={enabled.includes(m)}
              />
              {label(m)} <small>Phase {i < 5 ? 1 : i < 9 ? 2 : 3}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <button disabled={busy}>
        {busy
          ? 'Saving…'
          : creating
            ? 'Create organization & invite admin'
            : 'Save organization'}
      </button>
    </PlatformForm>
  );
}
export function PlatformOrganizations() {
  const location = useLocation();
  const [offset, setOffset] = useState(0),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [plan, setPlan] = useState(''),
    [sort, setSort] = useState('created_at');
  const action = useAction();
  const path =
    '/organizations?' +
    new URLSearchParams({
      offset: String(offset),
      search,
      ...(status ? { status } : {}),
      ...(plan ? { plan } : {}),
      sort,
      direction: sort === 'name' ? 'asc' : 'desc',
    });
  return (
    <>
      <h1>Organizations</h1>
      {location.state?.notice && (
        <Notice result>{String(location.state.notice)}</Notice>
      )}
      <p>Manage access, rollout and usage across organizations.</p>
      <details className="management-panel">
        <summary>Add organization</summary>
        <OrganizationForm
          creating
          busy={action.busy}
          onSubmit={(v) => action.run('/organizations', 'POST', v)}
        />
      </details>
      {action.message && (
        <Notice key={action.message} result>
          {action.message}
        </Notice>
      )}
      <div className="platform-filters">
        <label>
          Search
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            {['trial', 'active', 'suspended'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Plan
          <input
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setOffset(0);
            }}
          >
            <option value="created_at">Newest</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <Data path={path}>
        {(d) => (
          <>
            <Table
              rows={(d.data as Row[]).map((r) => ({
                ...r,
                users: (r.usage as Row).users,
              }))}
              columns={[
                'name',
                'domain',
                'status',
                'plan',
                'users',
                'created_at',
              ]}
              actions={(r) => (
                <Link to={`${base}/organizations/${r.id}`}>Manage</Link>
              )}
            />
            <Pager
              offset={offset}
              total={(d.pagination as Page['pagination']).total}
              onChange={setOffset}
            />
          </>
        )}
      </Data>
    </>
  );
}
function OrganizationDetail() {
  const { id } = useParams();
  return (
    <Data path={`/organizations/${id}`}>
      {(d) => <DetailContent key={String(d.id)} value={d} />}
    </Data>
  );
}
function DetailContent({ value }: { value: Row }) {
  const navigate = useNavigate();
  const action = useAction(),
    [confirmation, setConfirmation] = useState(''),
    [reason, setReason] = useState('');
  const path = '/organizations/' + value.id;
  return (
    <>
      <Link to={`${base}/organizations`}>All organizations</Link>
      <h1>{String(value.name)}</h1>
      <span className="badge">{String(value.status)}</span>
      <h2>Profile, modules and limits</h2>
      <OrganizationForm
        key={String(value.updated_at)}
        value={value}
        busy={action.busy}
        onSubmit={(v) => action.run(path, 'PATCH', v)}
      />
      {action.message && (
        <Notice key={action.message} result>
          {action.message}
        </Notice>
      )}
      <h2>Usage this month</h2>
      <Table
        rows={[value.usage as Row]}
        columns={['users', 'call_minutes', 'unmetered_calls', 'storage_mb']}
      />
      <h2>HR administrators</h2>
      <Table
        rows={value.admins as Row[]}
        columns={['full_name', 'email', 'status', 'last_login_at']}
      />
      <button
        disabled={
          action.busy ||
          !value.last_invitation_id ||
          value.status === 'suspended'
        }
        onClick={() => void action.run(path + '/invitation', 'POST')}
      >
        Resend initial admin invitation
      </button>
      <h2>Organization status</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            window.confirm(
              value.status === 'suspended'
                ? 'Reactivate this organization?'
                : 'Suspend access for all organization users?',
            )
          )
            void action.run(path + '/status', 'POST', {
              status: value.status === 'suspended' ? 'active' : 'suspended',
              reason,
            });
        }}
      >
        <label>
          Suspension reason
          <input
            required={value.status !== 'suspended'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </label>
        <button disabled={action.busy}>
          {value.status === 'suspended' ? 'Reactivate' : 'Suspend'}
        </button>
      </form>
      <details>
        <summary>Delete organization</summary>
        <p>
          Data is retained. Access will be suspended. Type {String(value.name)}{' '}
          to confirm.
        </p>
        <input
          aria-label="Organization name confirmation"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        <button
          disabled={action.busy || confirmation !== value.name}
          onClick={async () => {
            if (
              window.confirm('Soft delete this organization?') &&
              (await action.run(path, 'DELETE', { confirmation }))
            )
              navigate('/super-admin/organizations', {
                state: {
                  notice: 'Organization deleted. Data has been retained.',
                },
              });
          }}
        >
          Confirm soft delete
        </button>
      </details>
      <h2>Organization audit trail</h2>
      <AuditLogs organization={String(value.id)} />
    </>
  );
}
function Dashboard() {
  return (
    <>
      <h1>Platform dashboard</h1>
      <Data path="/dashboard">
        {(d) => (
          <>
            <div className="cards">
              {[
                'total_organizations',
                'trial',
                'active',
                'suspended',
                'total_users',
                'new_this_month',
                'integrations_ok',
                'integrations_failing',
              ].map((k) => (
                <article key={k}>
                  <h2>{label(k)}</h2>
                  <strong className="kpi">{display(d[k])}</strong>
                </article>
              ))}
            </div>
            <h2>Organizations needing attention</h2>
            <Table
              rows={d.attention as Row[]}
              columns={['name', 'status', 'trial_ends_at']}
              actions={(r) => (
                <Link to={`${base}/organizations/${r.id}`}>Manage</Link>
              )}
            />
            <h2>Recent activity</h2>
            <Table
              rows={d.recent_events as Row[]}
              columns={['created_at', 'action', 'entity_type']}
            />
          </>
        )}
      </Data>
    </>
  );
}
function AuditLogs({ organization }: { organization?: string }) {
  const [offset, setOffset] = useState(0),
    [action, setAction] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [organizationFilter, setOrganizationFilter] = useState('');
  const selectedOrganization = organization ?? organizationFilter;
  const validOrganization =
    !selectedOrganization ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      selectedOrganization,
    );
  const params = new URLSearchParams({
    offset: String(offset),
    ...(action ? { action } : {}),
    ...(selectedOrganization && validOrganization
      ? { organization_id: selectedOrganization }
      : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
    limit: '25',
  });
  return (
    <>
      <div className="platform-filters">
        {!organization && (
          <label>
            Organization ID
            <input
              aria-label="Organization ID"
              value={organizationFilter}
              aria-invalid={!validOrganization}
              aria-describedby="audit-organization-help"
              onChange={(e) => {
                setOrganizationFilter(e.target.value);
                setOffset(0);
              }}
            />
            <small id="audit-organization-help">
              {validOrganization
                ? 'Leave empty for all organizations.'
                : 'Enter a valid organization UUID.'}
            </small>
          </label>
        )}
        <label>
          Action
          <input
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <a
          aria-disabled={!validOrganization}
          onClick={(e) => {
            if (!validOrganization) e.preventDefault();
          }}
          href={`/api/v1${base}/audit-logs/export?${params}`}
          download
        >
          Export current page (CSV)
        </a>
      </div>
      {validOrganization && (
        <Data path={'/audit-logs?' + params}>
          {(d) => (
            <>
              <Table
                rows={d.data as Row[]}
                columns={[
                  'created_at',
                  'action',
                  'entity_type',
                  'entity_id',
                  'actor_id',
                  'metadata',
                ]}
              />
              <Pager
                offset={offset}
                total={(d.pagination as Page['pagination']).total}
                onChange={setOffset}
              />
            </>
          )}
        </Data>
      )}
    </>
  );
}
function Reports() {
  return (
    <>
      <h1>Platform reports</h1>
      <p>
        Aggregate usage only. Unmetered calls have no reported duration. Storage
        counts retained candidate documents.
      </p>
      <Data path="/reports">
        {(d) => (
          <>
            <Table
              rows={(d.organizations as Row[]).map((r) => ({
                ...r,
                ...(r.usage as Row),
              }))}
              columns={[
                'name',
                'status',
                'users',
                'call_minutes',
                'unmetered_calls',
                'storage_mb',
              ]}
            />
            <h2>Integration errors</h2>
            <Table
              rows={d.integrations as Row[]}
              columns={['provider', 'environment', 'status', 'error_count']}
            />
          </>
        )}
      </Data>
    </>
  );
}
function Integrations() {
  const action = useAction();
  return (
    <>
      <h1>Integrations</h1>
      <p>
        Credentials are encrypted. Verify sandbox before enabling production.
        Saving replaces credentials and resets verification.
      </p>
      <PlatformForm
        className="platform-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            v = Object.fromEntries(new FormData(form));
          if (
            await action.run('/integrations', 'POST', {
              ...v,
              organization_id: v.organization_id || null,
            })
          )
            form.reset();
        }}
      >
        <Fields
          fields={[
            {
              name: 'provider',
              options: [
                'openai',
                'google_calendar',
                'microsoft_calendar',
                'telephony',
                'email',
                'careers_cms',
                'e_signature',
                'hris',
              ],
            },
            { name: 'environment', options: ['sandbox', 'production'] },
            { name: 'organization_id', required: false },
            {
              name: 'credential',
              type: 'password',
              minLength: 8,
              maxLength: 8192,
            },
          ]}
        />
        <small>
          Leave organization ID empty for the platform connection. Calendar
          connections use OAuth access tokens.
        </small>
        <button disabled={action.busy}>Save connection</button>
      </PlatformForm>
      {action.message && (
        <Notice key={action.message} result>
          {action.message}
        </Notice>
      )}
      <IntegrationList action={action} />
    </>
  );
}
function IntegrationList({ action }: { action: ReturnType<typeof useAction> }) {
  const q = useQuery({
    queryKey: ['platform', 'integrations'],
    queryFn: () => api<Row[]>(base + '/integrations'),
  });
  if (q.isPending) return <Notice>Loading connections…</Notice>;
  if (q.isError)
    return (
      <div role="alert">
        Unable to load connections{' '}
        <button onClick={() => void q.refetch()}>Retry</button>
      </div>
    );
  return (
    <Table
      rows={q.data}
      columns={[
        'provider',
        'scope',
        'organization_id',
        'environment',
        'credential_hint',
        'status',
        'last_verified_at',
      ]}
      actions={(r) => (
        <>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(`/integrations/${r.id}/test`, 'POST')
            }
          >
            Test connection
          </button>
          <button
            disabled={
              action.busy || !['ok', 'enabled'].includes(String(r.status))
            }
            onClick={() => {
              if (window.confirm('Enable this connection?'))
                void action.run(`/integrations/${r.id}/enable`, 'POST');
            }}
          >
            Enable
          </button>
        </>
      )}
    />
  );
}
function SettingsContent({ data }: { data: Row }) {
  const action = useAction(),
    values = data.defaults as Row;
  const numeric = Object.keys(values).filter((k) => k !== 'emergency_pause');
  const admins = useQuery({
    queryKey: ['platform', 'admins'],
    queryFn: () => api<Row[]>(base + '/admins'),
  });
  return (
    <>
      <h2>Global defaults and calling controls</h2>
      <PlatformForm
        className="platform-form"
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void action.run('/settings', 'PATCH', {
            ...Object.fromEntries(numeric.map((k) => [k, Number(d.get(k))])),
            emergency_pause: d.has('emergency_pause'),
          });
        }}
      >
        <Fields
          fields={numeric.map((name) => ({
            name,
            type: 'number',
            min:
              name === 'password_min_length'
                ? 12
                : name === 'session_seconds'
                  ? 300
                  : 0,
          }))}
          value={values}
        />
        <label>
          <input
            type="checkbox"
            name="emergency_pause"
            defaultChecked={Boolean(values.emergency_pause)}
          />
          Emergency calling pause
        </label>
        <button disabled={action.busy}>Save defaults</button>
      </PlatformForm>
      <h2>Role templates</h2>
      <ul>
        {(data.roles as string[]).map((r) => (
          <li key={r}>
            {label(r.toLowerCase())}:{' '}
            {display(
              (data.role_templates as Record<string, unknown> | undefined)?.[
                r
              ] ?? 'Own role workspace',
            )}
          </li>
        ))}
      </ul>
      <h2>Super Admin accounts</h2>
      {admins.isPending ? (
        <Notice>Loading administrators…</Notice>
      ) : admins.isError ? (
        <div role="alert">
          Unable to load administrators{' '}
          <button onClick={() => void admins.refetch()}>Retry</button>
        </div>
      ) : (
        <Table
          rows={admins.data}
          columns={['full_name', 'email', 'status', 'last_login_at']}
          actions={(r) => (
            <button
              disabled={action.busy}
              onClick={() => {
                if (
                  window.confirm(
                    `${r.active ? 'Disable' : 'Activate'} this administrator?`,
                  )
                )
                  void action.run(`/admins/${r.id}`, 'PATCH', {
                    active: !r.active,
                  });
              }}
            >
              {r.active ? 'Disable' : 'Activate'}
            </button>
          )}
        />
      )}
      <details>
        <summary>Add Super Admin</summary>
        <PlatformForm
          className="platform-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            if (
              await action.run(
                '/admins',
                'POST',
                Object.fromEntries(new FormData(form)),
              )
            )
              form.reset();
          }}
        >
          <Fields
            fields={[
              { name: 'fullName' },
              { name: 'email', type: 'email' },
              { name: 'password', type: 'password' },
            ]}
          />
          <p>
            Share the initial password through a secure channel. Password change
            is required on first sign-in.
          </p>
          <button disabled={action.busy}>Add administrator</button>
        </PlatformForm>
      </details>
      {action.message && (
        <Notice key={action.message} result>
          {action.message}
        </Notice>
      )}
    </>
  );
}
export function PasswordChange() {
  const auth = useAuth(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
      });
      auth.retry();
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : 'Unable to change password',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Change your initial password</h1>
      <p>Choose a new password before accessing your workspace.</p>
      <PlatformForm className="platform-form" onSubmit={submit}>
        <Fields
          fields={[
            { name: 'currentPassword', type: 'password' },
            { name: 'password', type: 'password' },
          ]}
        />
        <button disabled={busy}>Change password</button>
      </PlatformForm>
      {message && <Notice>{message}</Notice>}
    </section>
  );
}
export function SuperAdminPage() {
  const { session } = useAuth(),
    { section } = useParams();
  if (session?.user.role !== 'SUPER_ADMIN')
    return (
      <section>
        <h1>Not authorized</h1>
        <Link to="/">Return home</Link>
      </section>
    );
  switch (section) {
    case 'dashboard':
      return <Dashboard />;
    case 'organizations':
      return <PlatformOrganizations />;
    case 'integrations':
      return <Integrations />;
    case 'settings':
      return (
        <>
          <h1>Settings</h1>
          <Data path="/settings">{(d) => <SettingsContent data={d} />}</Data>
        </>
      );
    case 'audit-logs':
      return (
        <>
          <h1>Audit logs</h1>
          <AuditLogs />
        </>
      );
    case 'reports':
      return <Reports />;
    default:
      return <h1>Page not found</h1>;
  }
}
export function SuperAdminDetail() {
  const { session } = useAuth();
  return session?.user.role === 'SUPER_ADMIN' ? (
    <OrganizationDetail />
  ) : (
    <h1>Not authorized</h1>
  );
}
