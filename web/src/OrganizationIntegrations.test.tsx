import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import App from './App';
function setup(role = 'HR_ADMIN', enabled = true) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/session')
      return Response.json({
        user: {
          id: 'u',
          tenant_id: 'org',
          full_name: 'Admin',
          email: 'admin@example.test',
          role,
          active: true,
        },
        expiresAt: Date.now() + 900000,
      });
    if (init.method === 'POST' || init.method === 'PATCH')
      return Response.json({ id: 'connection' });
    if (url.endsWith('/providers') || url.endsWith('/integration-providers'))
      return Response.json(
        enabled
          ? [
              {
                provider: 'openai',
                label: 'OpenAI',
                enabled: true,
                methods: ['api_key'],
                fields: { api_key: ['apiKey'] },
              },
            ]
          : [],
      );
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthProvider>
        <MemoryRouter
          initialEntries={[
            role === 'SUPER_ADMIN'
              ? '/super-admin/integrations'
              : '/integrations',
          ]}
        >
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
it('shows only enabled providers and saves credentials without client tenant scope', async () => {
  const fetcher = setup();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Connect OpenAI' }),
  );
  const field = screen.getByLabelText('API key');
  await userEvent.type(field, 'organization-owned-key');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save connection' }),
  );
  await screen.findByText('Changes saved.');
  const call = fetcher.mock.calls.find(
    ([url, init]) =>
      url === '/api/v1/organization/integrations' && init.method === 'POST',
  );
  expect(JSON.parse(call![1].body as string)).toEqual({
    provider: 'openai',
    environment: 'sandbox',
    method: 'api_key',
    credentials: { apiKey: 'organization-owned-key' },
  });
  expect(field).toHaveValue('');
  expect(screen.queryByText('Google Calendar')).not.toBeInTheDocument();
});
it('explains when the platform has not enabled any providers', async () => {
  setup('HR_ADMIN', false);
  expect(
    await screen.findByText(
      'No providers are enabled. Contact your platform administrator.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Save connection' }),
  ).not.toBeInTheDocument();
});
it('denies a recruiter before fetching organization connections', async () => {
  const fetcher = setup('RECRUITER');
  expect(
    await screen.findByRole('heading', { name: 'Not authorized' }),
  ).toBeVisible();
  expect(
    fetcher.mock.calls.some(([url]) =>
      url.includes('/organization/integrations'),
    ),
  ).toBe(false);
});
it('lets Super Admin disable provider availability separately from platform credentials', async () => {
  const fetcher = setup('SUPER_ADMIN');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Disable OpenAI' }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/super-admin/integration-providers/openai' &&
          init.method === 'PATCH' &&
          init.body === JSON.stringify({ enabled: false }),
      ),
    ).toBe(true),
  );
  vi.restoreAllMocks();
});
