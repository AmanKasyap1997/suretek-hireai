import {
  OrganizationIntegrations,
  IntegrationOAuthCallback,
} from './OrganizationIntegrations';
import {
  SuperAdminPage,
  SuperAdminDetail,
  PasswordChange,
} from './SuperAdminPages';
import { Component, useState, type ReactNode } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  Link,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from './auth';
import { loginError } from './api';
import { Brand, WorkspaceIcon } from './Brand';
import { Team, AcceptInvitation } from './SaasPages';
import {
  allowedDestination,
  homePath,
  navigation,
  permissionMap,
  roleLabel,
  visibleNavigation,
  moduleForMenu,
} from './permissions';
const schema = z.object({
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
      'Enter the organization key from your invitation.',
    ),
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.').max(1024),
});
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="standalone">
        <h1>Something went wrong</h1>
        <p>Please reload the console to try again.</p>
        <a href="/console/">Reload console</a>
      </main>
    ) : (
      this.props.children
    );
  }
}
export function Guard() {
  const auth = useAuth(),
    location = useLocation();
  if (auth.status === 'loading')
    return (
      <main className="standalone" role="status">
        Loading your workspace…
      </main>
    );
  if (auth.status === 'error')
    return (
      <main className="standalone">
        <h1>Unable to load your session</h1>
        <button onClick={auth.retry}>Try again</button>
      </main>
    );
  if (auth.session?.user.must_change_password)
    return (
      <main className="standalone">
        <PasswordChange />
      </main>
    );
  return auth.session ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace state={{ from: location.pathname }} />
  );
}
function Login() {
  const auth = useAuth(),
    location = useLocation();
  const [show, setShow] = useState(false),
    [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      organizationSlug:
        typeof location.state?.organizationSlug === 'string'
          ? location.state.organizationSlug
          : (new URLSearchParams(location.hash.slice(1)).get('organization') ??
            import.meta.env.VITE_ORGANIZATION_SLUG ??
            'platform'),
    },
  });
  if (auth.session) {
    const from = location.state?.from;
    return (
      <Navigate
        replace
        to={
          typeof from === 'string' &&
          allowedDestination(from, auth.session.user.role)
            ? from
            : homePath(auth.session.user.role)
        }
      />
    );
  }
  return (
    <main className="login-grid">
      <header className="login-header">
        <Brand />
        <span className="platform-label">
          Recruitment &amp; People Platform
        </span>
      </header>
      <section className="welcome">
        <p className="eyebrow">WELCOME TO SURETEK HIREAI</p>
        <h1>
          Great people.
          <br />
          <span>New possibilities.</span>
        </h1>
        <p className="welcome-copy">
          Your recruitment and people workspace, together in one place. Sign in
          to continue where you left off.
        </p>
        <div className="workspace-preview" aria-label="Workspace introduction">
          <div className="preview-heading">
            <WorkspaceIcon name="home" />
            <strong>Your Suretek workspace</strong>
          </div>
          <div className="preview-modules">
            {[
              ['jobs', 'Recruitment'],
              ['interviews', 'Interviews'],
              ['people', 'People'],
            ].map(([id, label]) => (
              <div key={id}>
                <span className="icon-tile">
                  <WorkspaceIcon name={id} />
                </span>
                <strong>{label}</strong>
                <small>Coming soon</small>
              </div>
            ))}
          </div>
          <p>One account. A workspace tailored to your role.</p>
        </div>
      </section>
      <section className="login-panel">
        {auth.logoutError && (
          <div role="alert">
            <p>{auth.logoutError}</p>
            <button onClick={() => void auth.logout()}>Retry sign-out</button>
          </div>
        )}
        <form
          onSubmit={handleSubmit(async (values) => {
            setError('');
            try {
              await auth.login(
                values.email,
                values.password,
                values.organizationSlug,
              );
            } catch (e) {
              setError(loginError(e));
            }
          })}
          noValidate
        >
          <p className="eyebrow">WELCOME BACK</p>
          <h2>Sign in</h2>
          <p className="muted">Use your work account to continue.</p>
          {auth.expired && (
            <p role="status" className="notice">
              Your session expired. Sign in again to continue.
            </p>
          )}
          <label htmlFor="organization">Organization</label>
          <input
            id="organization"
            autoComplete="organization"
            {...register('organizationSlug')}
            aria-invalid={!!errors.organizationSlug}
            aria-describedby={
              errors.organizationSlug
                ? 'organization-help organization-error'
                : 'organization-help'
            }
          />
          <small id="organization-help">
            Use the organization key in your invitation email.
          </small>
          {errors.organizationSlug && (
            <p id="organization-error" className="error" role="alert">
              {errors.organizationSlug.message}
            </p>
          )}
          <label htmlFor="email">Email</label>
          <input
            id="email"
            autoComplete="username"
            type="email"
            {...register('email')}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'email-error' : undefined}
          />
          {errors.email && (
            <p id="email-error" className="error" role="alert">
              {errors.email.message}
            </p>
          )}
          <label htmlFor="password">Password</label>
          <div className="password">
            <input
              id="password"
              autoComplete="current-password"
              type={show ? 'text' : 'password'}
              {...register('password')}
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
            />
            <button
              type="button"
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
              onClick={() => setShow(!show)}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
          {errors.password && (
            <p id="password-error" className="error" role="alert">
              {errors.password.message}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="help">
            Need access or password help? Contact your administrator.
          </p>
        </form>
        <small>
          <WorkspaceIcon name="lock" /> Your workspace. Securely connected.
        </small>
      </section>
      <footer className="login-footer">
        Suretek Infosoft · HireAI &amp; HRMS
      </footer>
    </main>
  );
}
function Shell() {
  const { session, logout } = useAuth(),
    navigate = useNavigate();
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(
    typeof window !== 'undefined' && window.innerWidth > 900,
  );
  if (!session) return null;
  const user = session.user;
  return (
    <div className={`shell ${menuOpen ? 'menu-open' : 'menu-closed'}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <button
          className="menu-toggle"
          aria-label="Toggle navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          Menu
        </button>
        <Brand />
        <span className="platform-label">
          Recruitment &amp; People Platform
        </span>
        <details>
          <summary>
            <span className="avatar" aria-hidden="true">
              {user.full_name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              {user.full_name}
              <span className="role">
                {roleLabel(user.role)} | {user.organization_name}
              </span>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <button
            onClick={async () => {
              try {
                await logout();
                navigate('/login', { replace: true });
              } catch {
                setError(
                  'Signed out locally. Server sign-out failed; close this browser and retry when connected.',
                );
              }
            }}
          >
            Sign out
          </button>
        </details>
      </header>
      <aside
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setMenuOpen(false);
            document.querySelector<HTMLButtonElement>('.menu-toggle')?.focus();
          }
        }}
        onClick={(e) => {
          if (window.innerWidth <= 900 && (e.target as Element).closest('a'))
            setMenuOpen(false);
        }}
      >
        <div className="sidebar-title">
          Suretek <strong>HireAI</strong>
          <span>{user.organization_name ?? 'by Suretek Infosoft'}</span>
        </div>
        <nav aria-label="Main navigation">
          {user.role !== 'SUPER_ADMIN' && (
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-home' : 'nav-feature'
              }
              to={homePath(user.role)}
            >
              <WorkspaceIcon name="home" /> Overview
            </NavLink>
          )}
          {visibleNavigation(user.role, user.enabled_modules, user.roles).map(
            (item) =>
              item.built ? (
                <NavLink
                  key={item.id}
                  className={({ isActive }) =>
                    isActive ? 'nav-home' : 'nav-feature'
                  }
                  to={item.path ?? `/${item.id}`}
                >
                  <WorkspaceIcon name={item.id} />
                  {item.label}
                </NavLink>
              ) : (
                <button disabled key={item.id}>
                  <WorkspaceIcon name={item.id} />
                  <span>
                    {item.label}
                    <small>Coming soon</small>
                  </span>
                </button>
              ),
          )}
        </nav>
        <div className="sidebar-footer">
          <WorkspaceIcon name="lock" />
          <strong>Your role workspace</strong>
          <p>Access is managed by your administrator.</p>
        </div>
      </aside>
      <div className="workspace">
        {error && <p role="alert">{error}</p>}
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
function Forbidden() {
  return (
    <section className="state">
      <p className="eyebrow">ACCESS RESTRICTED</p>
      <h1>Not authorized</h1>
      <p>Your account does not have access to this page.</p>
      <Link to="/">Back to your overview</Link>
    </section>
  );
}
function Home() {
  const { session } = useAuth(),
    { role } = useParams();
  if (!session) return null;
  if (role !== session.user.role.toLowerCase()) return <Forbidden />;
  if (session.user.role === 'SUPER_ADMIN')
    return <Navigate replace to="/super-admin/dashboard" />;
  const items = visibleNavigation(
    session.user.role,
    session.user.enabled_modules,
    session.user.roles,
  );
  return (
    <>
      <p className="eyebrow">YOUR CONSOLE</p>
      <h1>{roleLabel(session.user.role)} overview</h1>
      <p className="intro">
        Welcome, {session.user.full_name}. Here is what is available for your
        role.
      </p>
      <div className="welcome-card">
        <span className="icon-tile">
          <WorkspaceIcon name="lock" />
        </span>
        <div>
          <strong>Your account is ready</strong>
          <p>
            We are building your workspace. New tools will appear here as they
            become available.
          </p>
        </div>
      </div>
      <h2>Your workspace</h2>
      <div className="cards">
        {items.length ? (
          items.map((item) => (
            <article key={item.id}>
              <span className="icon-tile">
                <WorkspaceIcon name={item.id} />
              </span>
              <span className="badge">
                {item.built ? 'Available' : 'Coming soon'}
              </span>
              <h3>{item.label}</h3>
              <p>
                {item.built
                  ? 'Invite staff and manage access within your organization.'
                  : `Tools for your ${item.label.toLowerCase()} workflow will be available in a future update.`}
              </p>
              {item.built ? (
                <Link to={`/${item.id}`}>Open {item.label}</Link>
              ) : (
                <button disabled>Coming soon</button>
              )}
            </article>
          ))
        ) : (
          <article>
            <span className="badge">Coming soon</span>
            <h3>Your role workspace</h3>
            <p>
              No additional tools are available for this role yet. Your account
              is active.
            </p>
          </article>
        )}
      </div>
    </>
  );
}
function Future({ id }: { id: string }) {
  const { session } = useAuth();
  if (
    session?.user.enabled_modules &&
    moduleForMenu[id] &&
    !session.user.enabled_modules.includes(moduleForMenu[id])
  )
    return <Forbidden />;
  if (
    session &&
    [session.user.role, ...(session.user.roles ?? [])].some((r) =>
      permissionMap[r].includes(id),
    )
  ) {
    if (id === 'organizations')
      return <Navigate replace to="/super-admin/organizations" />;
    if (id === 'team') return <Team />;
  }
  return session && permissionMap[session.user.role].includes(id) ? (
    <section className="state">
      <h1>Coming soon</h1>
      <p>This workspace is being prepared.</p>
      <Link to="/">Back to overview</Link>
    </section>
  ) : (
    <Forbidden />
  );
}
function Index() {
  const { session } = useAuth();
  return session ? <Navigate replace to={homePath(session.user.role)} /> : null;
}
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invitation" element={<AcceptInvitation />} />
      <Route element={<Guard />}>
        <Route element={<Shell />}>
          <Route index element={<Index />} />
          <Route path="super-admin/:section" element={<SuperAdminPage />} />
          <Route
            path="super-admin/organizations/:id"
            element={<SuperAdminDetail />}
          />
          <Route path="integrations" element={<OrganizationIntegrations />} />
          <Route
            path="integrations/oauth"
            element={<IntegrationOAuthCallback />}
          />
          <Route path="home/:role" element={<Home />} />
          {navigation
            .filter((n) => n.id !== 'integrations')
            .map((n) => (
              <Route key={n.id} path={n.id} element={<Future id={n.id} />} />
            ))}
          <Route path="forbidden" element={<Forbidden />} />
          <Route
            path="*"
            element={
              <section className="state">
                <h1>Page not found</h1>
                <Link to="/">Back to overview</Link>
              </section>
            }
          />
        </Route>
      </Route>
    </Routes>
  );
}
