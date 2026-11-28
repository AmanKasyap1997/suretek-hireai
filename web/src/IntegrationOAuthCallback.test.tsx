import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationOAuthCallback } from './OrganizationIntegrations';

vi.mock('./auth', () => ({
  useAuth: () => ({ status: 'ready', session: { user: { role: 'HR_ADMIN' } } }),
}));

function setup(query: string, verify = true, complete = true) {
  window.history.replaceState(null, '', '/console/integrations/oauth' + query);
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/oauth/complete'))
      return Response.json(
        complete
          ? { id: 'connection' }
          : { message: 'OAuth request expired or already used; reconnect' },
        { status: complete ? 201 : 400 },
      );
    return Response.json({ ok: verify });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <IntegrationOAuthCallback />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  return fetcher;
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('completes and verifies once automatically, including in StrictMode', async () => {
  const fetcher = setup('?code=fixture&state=fixture');
  expect(await screen.findByText(/Connected and verified/)).toBeVisible();
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth/complete')),
  ).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/organization/integrations/connection/test',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(window.location.search).toBe('');
});
it('does not exchange a declined authorization', async () => {
  const fetcher = setup('?error=access_denied&state=fixture');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Authorization was declined',
  );
  await waitFor(() => expect(fetcher).not.toHaveBeenCalled());
});
it('distinguishes saved authorization from failed verification', async () => {
  setup('?code=fixture&state=fixture', false);
  expect(
    await screen.findByText(/Account connected, but verification failed/),
  ).toBeVisible();
});
it('shows exchange failure without attempting verification or replaying the code', async () => {
  const fetcher = setup('?code=fixture&state=fixture', true, false);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'expired or already used',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['', '?code=fixture', '?state=fixture'])(
  'does not exchange an incomplete callback: %s',
  async (query) => {
    const fetcher = setup(query);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Authorization details are missing',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  },
);
it('explains permissions the provider hasn’t approved for the app', () => {
  const fetcher = setup('?error=unauthorized_scope_error&state=fixture');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'LinkedIn must first approve Community Management API access',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not describe a provider error as declined consent or exchange it', () => {
  const fetcher = setup('?error=server_error&state=fixture&code=fixture');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The provider could not complete authorization',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
