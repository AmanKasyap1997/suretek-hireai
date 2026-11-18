import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import App, { Guard } from './App';
import userEvent from '@testing-library/user-event';
import { IntegrationOAuthCallback } from './OrganizationIntegrations';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('keeps an in-flight OAuth callback through a focus-triggered session refresh', async () => {
  window.history.replaceState(
    null,
    '',
    '/console/integrations/oauth?code=fixture&state=fixture',
  );
  const session = {
    user: {
      id: 'admin',
      tenant_id: 'org',
      full_name: 'Admin',
      email: 'admin@example.test',
      role: 'HR_ADMIN',
      active: true,
    },
    expiresAt: Date.now() + 900000,
  };
  let finishConnection!: (response: Response) => void;
  let finishSession!: (response: Response) => void;
  let sessionRequests = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/session')) {
      sessionRequests++;
      if (sessionRequests === 1) return Response.json(session);
      return new Promise<Response>((resolve) => {
        finishSession = resolve;
      });
    }
    if (url.endsWith('/oauth/complete'))
      return new Promise<Response>((resolve) => {
        finishConnection = resolve;
      });
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthProvider>
        <MemoryRouter initialEntries={['/integrations/oauth']}>
          <Routes>
            <Route element={<Guard />}>
              <Route
                path="/integrations/oauth"
                element={<IntegrationOAuthCallback />}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(finishConnection).toBeTypeOf('function'));
  expect(window.location.search).toBe('');
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(finishSession).toBeTypeOf('function'));
  await act(async () => finishSession(Response.json(session)));
  await act(async () => finishConnection(Response.json({ id: 'connection' })));
  expect(await screen.findByText(/Connected and verified/)).toBeVisible();
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth/complete')),
  ).toHaveLength(1);
  expect(screen.queryByText(/callback is incomplete/)).not.toBeInTheDocument();
});

it('retains the callback across a failed session refresh and retry in the real route tree', async () => {
  window.history.replaceState(
    null,
    '',
    '/console/integrations/oauth?code=fixture&state=fixture',
  );
  const session = {
    user: {
      id: 'admin',
      tenant_id: 'org',
      full_name: 'Admin',
      email: 'admin@example.test',
      role: 'HR_ADMIN',
      active: true,
    },
    expiresAt: Date.now() + 900000,
  };
  let finishConnection!: (response: Response) => void;
  let sessionRequests = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/session')) {
      sessionRequests++;
      return sessionRequests === 2
        ? Response.json({ message: 'Temporary failure' }, { status: 503 })
        : Response.json(session);
    }
    if (url.endsWith('/oauth/complete'))
      return new Promise<Response>((resolve) => {
        finishConnection = resolve;
      });
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthProvider>
        <MemoryRouter initialEntries={['/integrations/oauth']}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(finishConnection).toBeTypeOf('function'));
  expect(window.location.search).toBe('');
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByRole('heading', { name: 'Unable to load your session' });
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(sessionRequests).toBe(3));
  await act(async () => finishConnection(Response.json({ id: 'connection' })));
  expect(await screen.findByText(/Connected and verified/)).toBeVisible();
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth/complete')),
  ).toHaveLength(1);
  expect(screen.queryByText(/callback is incomplete/)).not.toBeInTheDocument();
});

it.each(['SUPER_ADMIN', 'RECRUITER', 'expired', 'password-change'])(
  'does not exchange a callback for an ineligible session: %s',
  async (role) => {
    window.history.replaceState(
      null,
      '',
      '/console/integrations/oauth?code=fixture&state=fixture',
    );
    const fetcher = vi.fn(async (url: string) => {
      if (!url.endsWith('/auth/session'))
        throw new Error('Unexpected provider exchange');
      return role === 'expired'
        ? Response.json({}, { status: 401 })
        : Response.json({
            user: {
              id: 'user',
              tenant_id: 'org',
              full_name: 'User',
              email: 'user@example.test',
              role: role === 'password-change' ? 'HR_ADMIN' : role,
              roles: role === 'SUPER_ADMIN' ? ['HR_ADMIN'] : [],
              must_change_password: role === 'password-change',
              active: true,
            },
            expiresAt: Date.now() + 900000,
          });
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/integrations/oauth']}>
            <App />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', {
      name:
        role === 'expired'
          ? 'Sign in to connect your provider'
          : 'Not authorized',
    });
    expect(
      fetcher.mock.calls.every(([url]) => url.endsWith('/auth/session')),
    ).toBe(true);
    expect(window.location.search).toBe('');
  },
);
