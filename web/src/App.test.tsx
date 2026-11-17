import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, it, expect, vi } from 'vitest';
import App from './App';
import { AuthProvider } from './auth';
import { api, ApiError, loginError } from './api';
import {
  roles,
  roleLabel,
  visibleNavigation,
  homePath,
  type Role,
} from './permissions';
const session = (role: Role) => ({
  user: {
    id: 'u',
    tenant_id: 't',
    full_name: 'Test person',
    email: 'test@console.test',
    role,
    active: true,
  },
  expiresAt: Date.now() + 900000,
});
function setup(path = '/', role?: Role, expiresAt?: number) {
  const cache = new QueryClient();
  cache.setQueryData(['private'], 'private data');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('/super-admin/dashboard')
              ? { attention: [], recent_events: [], total_organizations: 0 }
              : role
                ? { ...session(role), ...(expiresAt ? { expiresAt } : {}) }
                : {},
          ),
          {
            status: role ? 200 : 401,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ),
  );
  render(
    <QueryClientProvider client={cache}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return cache;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('role shell and sessions', () => {
  it.each(roles)(
    'loads %s home and navigation, denies another role home',
    async (role) => {
      setup(homePath(role), role);
      expect(
        await screen.findByRole('heading', {
          name:
            role === 'SUPER_ADMIN'
              ? 'Platform dashboard'
              : `${roleLabel(role)} overview`,
        }),
      ).toBeVisible();
      const nav = screen.getByRole('navigation');
      for (const item of visibleNavigation(role))
        expect(nav.textContent).toContain(item.label);
    },
  );
  it.each(roles)('guards forbidden home for %s', async (role) => {
    setup(homePath(role === 'SUPER_ADMIN' ? 'EMPLOYEE' : 'SUPER_ADMIN'), role);
    expect(
      await screen.findByRole('heading', { name: 'Not authorized' }),
    ).toBeVisible();
  });
  it('validates login without sending credentials, supports password visibility', async () => {
    setup('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeVisible();
    expect(screen.getByText('Enter your password.')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Show password' }),
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });
  it('clears cached data and returns to login on logout', async () => {
    const cache = setup('/', 'RECRUITER');
    await screen.findByText('Recruiter overview');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await userEvent.click(screen.getByText('Test person'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(cache.getQueryData(['private'])).toBeUndefined();
  });
  it('any API 401 expires the session and clears cache', async () => {
    const cache = setup('/', 'HR_ADMIN');
    await screen.findByText('Organization Admin overview');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(api('/jobs')).rejects.toBeInstanceOf(ApiError);
    await screen.findByText('Your session expired. Sign in again to continue.');
    expect(cache.getQueryData(['private'])).toBeUndefined();
  });
  it('expires on its deadline', async () => {
    setup('/', 'EMPLOYEE', Date.now() + 150);
    await waitFor(() =>
      expect(
        screen.getByText('Your session expired. Sign in again to continue.'),
      ).toBeVisible(),
    );
  });
  it.each([
    [401, 'Email or password'],
    [423, 'suspended'],
    [429, 'Too many'],
    [0, 'Cannot reach'],
    [503, 'temporarily unavailable'],
  ])('has distinct safe error for %s', (status, message) =>
    expect(loginError(new ApiError(Number(status)))).toContain(message),
  );
});
