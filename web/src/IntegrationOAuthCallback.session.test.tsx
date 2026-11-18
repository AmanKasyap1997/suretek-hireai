import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import { Guard } from './App';
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
