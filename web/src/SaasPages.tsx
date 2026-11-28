import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { Brand } from './Brand';
import { roles, roleLabel, type Role } from './permissions';
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    'Use 3–63 lowercase letters, numbers or hyphens.',
  );
const name = z.string().trim().min(1, 'Enter a name.').max(200);
const organizationSchema = z.object({
  name,
  slug,
  adminName: name,
  adminEmail: z.email('Enter a valid email address.'),
});
const staffRoles = roles.filter(
  (r) => r !== 'SUPER_ADMIN' && r !== 'HR_ADMIN',
) as [Role, ...Role[]];
const staffSchema = z.object({
  fullName: name,
  email: z.email('Enter a valid email address.'),
  role: z.enum(staffRoles),
});
const passwordSchema = z
  .object({
    password: z.string().min(12, 'Use at least 12 characters.').max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords must match.',
  });
type Page<T> = {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
};
type Organization = {
  id: string;
  name: string;
  slug: string;
  admin_name: string;
  admin_email: string;
  delivery_status: string;
};
type Staff = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  active: boolean;
  invitation_pending: boolean;
  password_set: boolean;
  invitation_expires_at: string | null;
  delivery_status: string | null;
};
function errorMessage(error: unknown) {
  const status = error instanceof ApiError ? error.status : 0;
  return status === 409
    ? 'This organization key or account already exists, or the invitation has already been accepted.'
    : status === 403
      ? 'You do not have permission for this action.'
      : status === 429
        ? 'Too many attempts. Wait one minute and try again.'
        : status === 0
          ? 'Cannot reach the server. Check your connection and try again.'
          : 'The request could not be completed. Please try again.';
}
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p id={`${id}-error`} className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="pagination">
      <span>{total} total</span>
      <button
        disabled={offset === 0}
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
function Delivery({ status }: { status: string | null }) {
  return (
    <span
      className={`delivery ${status === 'SENT' ? 'delivered' : 'not-delivered'}`}
    >
      {status === 'SENT'
        ? 'Email sent'
        : status === 'FAILED'
          ? 'Email failed'
          : 'Email pending'}
    </span>
  );
}
function LoadError({
  retry,
  platform = false,
}: {
  retry: () => void;
  platform?: boolean;
}) {
  return (
    <div role="alert" className="notice">
      <p>
        {platform
          ? 'Unable to load organizations. Your account must be provisioned as a platform administrator.'
          : 'Unable to load your team.'}
      </p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}
export function Organizations() {
  const cache = useQueryClient();
  const [offset, setOffset] = useState(0),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof organizationSchema>>({
    resolver: zodResolver(organizationSchema),
  });
  const query = useQuery({
    queryKey: ['organizations', offset],
    queryFn: () =>
      api<Page<Organization>>(`/saas/organizations?limit=25&offset=${offset}`),
  });
  async function resend(id: string) {
    setBusy(id);
    setMessage('');
    try {
      const r = await api<{ deliveryStatus: string }>(
        `/saas/organizations/${id}/admin-invitation`,
        { method: 'POST' },
      );
      setMessage(
        r.deliveryStatus === 'SENT'
          ? 'A new admin invitation was emailed. Earlier invitation links are no longer valid.'
          : 'The email could not be sent. Check email delivery and retry.',
      );
      await cache.invalidateQueries({ queryKey: ['organizations'] });
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section>
      <p className="eyebrow">PLATFORM ADMINISTRATION</p>
      <h1>Organizations</h1>
      <p className="intro">
        Create an organization and invite its administrator. Each organization
        manages its own people and recruitment.
      </p>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="management-grid">
        <section className="management-panel">
          <h2>Create organization</h2>
          <p className="muted">
            The admin receives an email to set their own password.
          </p>
          <form
            onSubmit={handleSubmit(async (values) => {
              setMessage('');
              try {
                const r = await api<{ deliveryStatus: string }>(
                  '/saas/organizations',
                  { method: 'POST', body: JSON.stringify(values) },
                );
                reset();
                setOffset(0);
                setMessage(
                  r.deliveryStatus === 'SENT'
                    ? 'Organization created. The admin invitation was emailed.'
                    : 'Organization created, but the invitation email could not be sent. Retry from the organization list after checking email delivery.',
                );
                await cache.invalidateQueries({ queryKey: ['organizations'] });
              } catch (e) {
                setMessage(errorMessage(e));
              }
            })}
            noValidate
          >
            <Field
              id="org-name"
              label="Organization name"
              error={errors.name?.message}
            >
              <input
                id="org-name"
                {...register('name')}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? 'org-name-error' : undefined}
              />
            </Field>
            <Field
              id="org-key"
              label="Organization key"
              error={errors.slug?.message}
            >
              <input
                id="org-key"
                {...register('slug')}
                aria-invalid={!!errors.slug}
                aria-describedby={
                  errors.slug ? 'org-key-error' : 'org-key-help'
                }
                autoCapitalize="none"
              />
              <small id="org-key-help">
                A unique sign-in key, for example acme.
              </small>
            </Field>
            <Field
              id="admin-name"
              label="Admin name"
              error={errors.adminName?.message}
            >
              <input
                id="admin-name"
                {...register('adminName')}
                aria-invalid={!!errors.adminName}
                aria-describedby={
                  errors.adminName ? 'admin-name-error' : undefined
                }
              />
            </Field>
            <Field
              id="admin-email"
              label="Admin email"
              error={errors.adminEmail?.message}
            >
              <input
                id="admin-email"
                type="email"
                {...register('adminEmail')}
                aria-invalid={!!errors.adminEmail}
                aria-describedby={
                  errors.adminEmail ? 'admin-email-error' : undefined
                }
              />
            </Field>
            <button
              className="primary"
              disabled={isSubmitting || query.isPending || query.isError}
            >
              {isSubmitting
                ? 'Creating…'
                : 'Create organization & invite admin'}
            </button>
          </form>
        </section>
        <section className="management-panel">
          <h2>Your organizations</h2>
          {query.isPending ? (
            <p role="status">Loading organizations…</p>
          ) : query.isError ? (
            <LoadError platform retry={() => void query.refetch()} />
          ) : (
            <>
              {!query.data?.data?.length ? (
                <p className="empty-state">
                  No organizations yet. Create your first organization to get
                  started.
                </p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Organization</th>
                        <th>Administrator</th>
                        <th>Invitation</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.data.map((org) => (
                        <tr key={org.id}>
                          <td>
                            <strong>{org.name}</strong>
                            <small>Sign-in key: {org.slug}</small>
                          </td>
                          <td>
                            {org.admin_name}
                            <small>{org.admin_email}</small>
                          </td>
                          <td>
                            <Delivery status={org.delivery_status} />
                          </td>
                          <td>
                            <button
                              disabled={busy !== null}
                              onClick={() => void resend(org.id)}
                              aria-label={`Resend admin invitation for ${org.name}`}
                            >
                              {busy === org.id
                                ? 'Sending…'
                                : 'Resend invitation'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination
                offset={offset}
                total={query.data?.pagination?.total ?? 0}
                onChange={setOffset}
              />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
export function Team() {
  const cache = useQueryClient();
  const [offset, setOffset] = useState(0),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof staffSchema>>({
    resolver: zodResolver(staffSchema),
    defaultValues: { role: 'RECRUITER' },
  });
  const query = useQuery({
    queryKey: ['team', offset],
    refetchOnWindowFocus: true,
    queryFn: () => api<Page<Staff>>(`/saas/users?limit=25&offset=${offset}`),
  });
  async function action(user: Staff, resend: boolean) {
    setBusy(user.id);
    setMessage('');
    try {
      if (resend) {
        const r = await api<{ deliveryStatus: string }>(
          `/saas/users/${user.id}/invitation`,
          { method: 'POST' },
        );
        setMessage(
          r.deliveryStatus === 'SENT'
            ? 'A new invitation was emailed. Earlier links are no longer valid.'
            : 'The invitation email could not be sent. Check email delivery and retry.',
        );
      } else {
        await api(`/auth/users/${user.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({
            active: !user.active && !user.invitation_pending,
          }),
        });
        setMessage('Account status updated.');
      }
      await cache.invalidateQueries({ queryKey: ['team'] });
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section style={{ padding: '2rem' }}>
      <p className="eyebrow">ORGANIZATION ADMINISTRATION</p>
      <h1>Team &amp; invitations</h1>
      <p className="intro">
        Invite staff and manage access within your organization. Invitations
        assign the selected role after acceptance. Hiring managers and
        interviewers then see a job once you add them to its hiring team (Jobs →
        Hiring team).
      </p>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="management-grid">
        <section className="management-panel">
          <h2>Invite team member</h2>
          <form
            noValidate
            onSubmit={handleSubmit(async (values) => {
              setMessage('');
              try {
                const r = await api<{ deliveryStatus: string }>(
                  '/saas/invitations',
                  { method: 'POST', body: JSON.stringify(values) },
                );
                reset({ fullName: '', email: '', role: 'RECRUITER' });
                setOffset(0);
                setMessage(
                  r.deliveryStatus === 'SENT'
                    ? 'Invitation emailed. The account becomes active after acceptance.'
                    : 'Account invited, but email delivery failed. Retry from the team list.',
                );
                await cache.invalidateQueries({ queryKey: ['team'] });
              } catch (e) {
                setMessage(errorMessage(e));
              }
            })}
          >
            <Field
              id="staff-name"
              label="Full name"
              error={errors.fullName?.message}
            >
              <input
                id="staff-name"
                {...register('fullName')}
                aria-invalid={!!errors.fullName}
                aria-describedby={
                  errors.fullName ? 'staff-name-error' : undefined
                }
              />
            </Field>
            <Field id="staff-email" label="Email" error={errors.email?.message}>
              <input
                id="staff-email"
                type="email"
                {...register('email')}
                aria-invalid={!!errors.email}
                aria-describedby={
                  errors.email ? 'staff-email-error' : undefined
                }
              />
            </Field>
            <Field id="staff-role" label="Role" error={errors.role?.message}>
              <select id="staff-role" {...register('role')}>
                {staffRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="primary"
              disabled={isSubmitting || query.isPending || query.isError}
            >
              {isSubmitting ? 'Inviting…' : 'Send invitation'}
            </button>
          </form>
        </section>
        <section className="management-panel">
          <div className="panel-heading">
            <h2>Organization members</h2>
            <button
              aria-label="Refresh team"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </button>
          </div>
          {query.isPending ? (
            <p role="status">Loading team…</p>
          ) : query.isError ? (
            <LoadError retry={() => void query.refetch()} />
          ) : (
            <>
              {!query.data?.data?.length ? (
                <p className="empty-state">No team members yet.</p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.data.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <strong>{user.full_name}</strong>
                            <small>{user.email}</small>
                          </td>
                          <td>{roleLabel(user.role)}</td>
                          <td>
                            {user.active
                              ? 'Active'
                              : user.invitation_pending
                                ? user.invitation_expires_at &&
                                  new Date(
                                    user.invitation_expires_at,
                                  ).getTime() < Date.now()
                                  ? 'Invitation expired'
                                  : 'Invited'
                                : 'Inactive'}
                            {user.invitation_pending && (
                              <small>
                                <Delivery status={user.delivery_status} />
                              </small>
                            )}
                          </td>
                          <td>
                            {staffRoles.includes(user.role) && (
                              <div className="row-actions">
                                {!user.active &&
                                  (user.invitation_pending ||
                                    !user.password_set) && (
                                    <button
                                      disabled={busy !== null}
                                      onClick={() => void action(user, true)}
                                      aria-label={`Resend invitation for ${user.full_name}`}
                                    >
                                      Resend invitation
                                    </button>
                                  )}
                                {(user.active ||
                                  user.invitation_pending ||
                                  user.password_set) && (
                                  <button
                                    disabled={busy !== null}
                                    onClick={() => void action(user, false)}
                                    aria-label={`${user.invitation_pending ? 'Cancel invitation' : user.active ? 'Deactivate' : 'Reactivate'} for ${user.full_name}`}
                                  >
                                    {user.invitation_pending
                                      ? 'Cancel invitation'
                                      : user.active
                                        ? 'Deactivate'
                                        : 'Reactivate'}
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination
                offset={offset}
                total={query.data?.pagination?.total ?? 0}
                onChange={setOffset}
              />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
export function AcceptInvitation() {
  const location = useLocation(),
    navigate = useNavigate(),
    auth = useAuth();
  const [invitation, setInvitation] = useState(() => {
    const p = new URLSearchParams(location.hash.slice(1));
    return {
      token: p.get('token') ?? '',
      organizationSlug: p.get('organization') ?? '',
    };
  });
  const [accepted, setAccepted] = useState(false),
    [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
  });
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }, []);
  return (
    <main className="invitation-page">
      <header className="login-header">
        <Brand />
      </header>
      <section className="invitation-panel">
        {accepted ? (
          <>
            <p className="eyebrow">YOU'RE READY</p>
            <h1>Invitation accepted</h1>
            <p>Sign in with your email and the password you just created.</p>
            <button
              className="primary"
              onClick={async () => {
                await auth.logout();
                navigate('/login', {
                  replace: true,
                  state: { organizationSlug: invitation.organizationSlug },
                });
              }}
            >
              Continue to sign in
            </button>
          </>
        ) : !invitation.token || !invitation.organizationSlug ? (
          <>
            <h1>Invitation link incomplete</h1>
            <p>
              Open the latest invitation email or contact your organization
              administrator.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">WELCOME TO SURETEK HIREAI</p>
            <h1>Accept your invitation</h1>
            <p className="muted">
              Organization: <strong>{invitation.organizationSlug}</strong>
            </p>
            <p>Create a password to activate your account.</p>
            <form
              noValidate
              onSubmit={handleSubmit(async (values) => {
                setError('');
                try {
                  await api(
                    '/saas/invitations/accept',
                    {
                      method: 'POST',
                      body: JSON.stringify({
                        organizationSlug: invitation.organizationSlug,
                        token: invitation.token,
                        password: values.password,
                      }),
                    },
                    true,
                  );
                  reset();
                  setInvitation((v) => ({ ...v, token: '' }));
                  setAccepted(true);
                } catch (e) {
                  setError(
                    e instanceof ApiError && e.status === 400
                      ? 'This invitation is invalid, expired, replaced, or already used. Ask your administrator for a new invitation.'
                      : errorMessage(e),
                  );
                }
              })}
            >
              <Field
                id="new-password"
                label="Create password"
                error={errors.password?.message}
              >
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  {...register('password')}
                  aria-invalid={!!errors.password}
                  aria-describedby={
                    errors.password ? 'new-password-error' : 'password-guidance'
                  }
                />
                <small id="password-guidance">Use 12–128 characters.</small>
              </Field>
              <Field
                id="confirm-password"
                label="Confirm password"
                error={errors.confirm?.message}
              >
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  {...register('confirm')}
                  aria-invalid={!!errors.confirm}
                  aria-describedby={
                    errors.confirm ? 'confirm-password-error' : undefined
                  }
                />
              </Field>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={isSubmitting}>
                {isSubmitting
                  ? 'Activating…'
                  : 'Accept invitation & set password'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
