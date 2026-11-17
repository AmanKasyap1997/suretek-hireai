import { Component, useState, type ReactNode } from 'react';
import {
  Navigate,
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
import {
  allowedDestination,
  homePath,
  navigation,
  permissionMap,
  roleLabel,
  visibleNavigation,
} from './permissions';
const schema = z.object({
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
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
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
      <section className="welcome">
        <div className="wordmark">
          SURETEK<span>Workspace</span>
        </div>
        <p className="eyebrow">PEOPLE. OPPORTUNITY. PROGRESS.</p>
        <h1>
          A shared place
          <br />
          to move forward.
        </h1>
        <p>Sign in to your Suretek workspace.</p>
        <div className="brand-note">
          Brand preview · logo, colours and type awaiting approved assets
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
              await auth.login(values.email, values.password);
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
        <small>Suretek · People operations</small>
      </section>
    </main>
  );
}
function Shell() {
  const { session, logout } = useAuth(),
    navigate = useNavigate();
  const [error, setError] = useState('');
  if (!session) return null;
  const user = session.user;
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside>
        <div className="wordmark">
          SURETEK<span>Console · brand preview</span>
        </div>
        <nav aria-label="Main navigation">
          <Link className="nav-home" to={homePath(user.role)}>
            Overview
          </Link>
          {visibleNavigation(user.role).map((item) => (
            <button disabled key={item.id}>
              {item.label}
              <small>Coming soon</small>
            </button>
          ))}
        </nav>
        <p className="sidebar-footer">A workspace for your role.</p>
      </aside>
      <div className="workspace">
        <header>
          <span className="workspace-title">Your workspace</span>
          <details>
            <summary>
              {user.full_name}
              <span className="role">{roleLabel(user.role)}</span>
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
      <h1>Not permitted</h1>
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
  const items = visibleNavigation(session.user.role);
  return (
    <>
      <p className="eyebrow">YOUR CONSOLE</p>
      <h1>{roleLabel(session.user.role)} overview</h1>
      <p className="intro">
        Welcome, {session.user.full_name}. Here is what is available for your
        role.
      </p>
      <div className="welcome-card">
        <span className="status-dot" />
        Your account is ready
        <p>
          We are building your workspace. New tools will appear here as they
          become available.
        </p>
      </div>
      <h2>Your workspace</h2>
      <div className="cards">
        {items.length ? (
          items.map((item) => (
            <article key={item.id}>
              <span className="badge">Coming soon</span>
              <h3>{item.label}</h3>
              <p>
                Tools for your {item.label.toLowerCase()} workflow will be
                available in a future update.
              </p>
              <button disabled>Coming soon</button>
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
      <Route element={<Guard />}>
        <Route element={<Shell />}>
          <Route index element={<Index />} />
          <Route path="home/:role" element={<Home />} />
          {navigation.map((n) => (
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
