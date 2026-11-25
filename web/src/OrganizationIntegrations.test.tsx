import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import App from './App';
function setup(
  role = 'HR_ADMIN',
  enabled = true,
  oauth = false,
  ready = false,
  startFails = false,
  connected = false,
  connectionList?: Record<string, unknown>[],
) {
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
    if (url.endsWith('/oauth/start') && startFails)
      return Response.json(
        { message: 'Integration encryption key is not configured' },
        { status: 503 },
      );
    if (url.endsWith('/oauth/start'))
      return Response.json({
        authorizationUrl:
          'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
      });
    if (
      url === '/api/v1/organization/integrations' &&
      connectionList &&
      !init.method
    )
      return Response.json(connectionList);
    if (url === '/api/v1/organization/integrations')
      return Response.json(
        connected
          ? [
              {
                id: 'google-connection',
                provider: 'google_calendar',
                environment: 'sandbox',
                method: 'oauth2',
                status: 'ok',
                credential_hint: 'Google account',
                last_verified_at: null,
              },
            ]
          : [],
      );
    if (init.method === 'POST' || init.method === 'PATCH')
      return Response.json({ id: 'connection' });
    if (url.endsWith('/providers') || url.endsWith('/integration-providers'))
      return Response.json(
        enabled
          ? [
              {
                provider: oauth ? 'google_calendar' : 'openai',
                label: oauth ? 'Google Calendar' : 'OpenAI',
                enabled: true,
                methods: oauth ? ['oauth2', 'bearer'] : ['api_key'],
                fields: oauth
                  ? { oauth2: [], bearer: ['accessToken'] }
                  : { api_key: ['apiKey'] },
                ...(oauth ? { hostedOAuth: ready, oauthReady: ready } : {}),
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
it('shows the backend failure on the integrations page when the popup closes', async () => {
  const close = vi.fn();
  const open = vi
    .spyOn(window, 'open')
    .mockReturnValue({ close, opener: null } as unknown as Window);
  setup('HR_ADMIN', true, true, true, true);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Authorize Google Calendar' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Integration encryption key is not configured',
  );
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  open.mockRestore();
});
it('opens Google authorization directly from the provider card when configured', async () => {
  const replace = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue({
    location: { replace },
    close: vi.fn(),
    opener: window,
  } as unknown as Window);
  const fetcher = setup('HR_ADMIN', true, true, true);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Authorize Google Calendar' }),
  );
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
    ),
  );
  const request = fetcher.mock.calls.find(([url]) =>
    url.endsWith('/oauth/start'),
  );
  expect(JSON.parse(request![1].body as string)).toEqual({
    provider: 'google_calendar',
    environment: 'sandbox',
    method: 'oauth2',
    credentials: {},
  });
  expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument();
  open.mockRestore();
});
it('falls back to manual credentials and explains missing authorization setup', async () => {
  setup('HR_ADMIN', true, true);
  expect(
    await screen.findByText(/Sign-in authorization isn’t set up by Suretek/),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Authorize Google Calendar' }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Connect Google Calendar' }),
  );
  expect(screen.getByLabelText('Connection method')).toHaveValue('bearer');
  expect(screen.getByLabelText('Access token')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled();
  await userEvent.selectOptions(
    screen.getByLabelText('Connection method'),
    'oauth2',
  );
  expect(
    screen.getByRole('button', { name: 'Connect with Google Calendar' }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Authorization requires platform setup/),
  ).toBeVisible();
  expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Close connection form' }),
  );
  expect(screen.queryByLabelText('Connection method')).not.toBeInTheDocument();
});
it('shows connected provider status and the next step on its card', async () => {
  setup('HR_ADMIN', true, true, true, false, true);
  const card = await screen.findByRole('article', { name: 'Google Calendar' });
  expect(within(card).getByText('Sandbox')).toBeVisible();
  expect(within(card).getByText('Verified')).toBeVisible();
  expect(within(card).getByText('Ready to enable')).toBeVisible();
  expect(
    within(card).getByRole('button', { name: 'Enable connection' }),
  ).toBeEnabled();
  // Less frequent actions sit in the row's "⋮" menu.
  const more = within(card).getByRole('button', {
    name: 'More actions for Google Calendar sandbox',
  });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(
    within(card).getByRole('button', { name: 'Add production connection' }),
  ).toBeVisible();
  expect(
    within(card).getByRole('button', { name: 'Disconnect' }),
  ).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(
    within(card).queryByRole('button', { name: 'Disconnect' }),
  ).not.toBeInTheDocument();
  expect(more).toHaveFocus();
});
it('guides a connection through testing and keeps paused connections removable', async () => {
  const fetcher = setup('HR_ADMIN', true, false, false, false, false, [
    {
      id: 'openai-sandbox',
      provider: 'openai',
      environment: 'sandbox',
      method: 'api_key',
      status: 'unverified',
      credential_hint: '****1234',
      last_verified_at: null,
    },
    {
      id: 'hris-sandbox',
      provider: 'hris',
      environment: 'sandbox',
      method: 'api_key',
      status: 'disabled',
      credential_hint: '****9876',
      last_verified_at: null,
    },
  ]);
  const card = await screen.findByRole('article', { name: 'OpenAI' });
  expect(within(card).getByText('Not tested')).toBeVisible();
  expect(
    within(card).getByRole('button', { name: 'Enable connection' }),
  ).toBeDisabled();
  expect(
    within(card).queryByRole('button', { name: 'Connect OpenAI' }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(card).getByRole('button', { name: 'Test connection' }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/organization/integrations/openai-sandbox/test' &&
          init.method === 'POST',
      ),
    ).toBe(true),
  );
  const paused = screen.getByRole('article', { name: 'HRIS' });
  expect(within(paused).getByText('Provider disabled')).toBeVisible();
  expect(
    within(paused).queryByRole('button', { name: 'Test connection' }),
  ).not.toBeInTheDocument();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await userEvent.click(
    within(paused).getByRole('button', {
      name: 'More actions for HRIS sandbox',
    }),
  );
  await userEvent.click(
    within(paused).getByRole('button', { name: 'Disconnect' }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/organization/integrations/hris-sandbox' &&
          init.method === 'DELETE',
      ),
    ).toBe(true),
  );
  vi.restoreAllMocks();
});
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
  expect(screen.getByText(/once the test passes/)).toBeVisible();
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

it('filters the page by category', async () => {
  setup('HR_ADMIN', true, false, false, false, false, [
    {
      id: 'hris-sandbox',
      provider: 'hris',
      environment: 'sandbox',
      method: 'api_key',
      status: 'disabled',
      credential_hint: '****9876',
      last_verified_at: null,
    },
  ]);
  const all = await screen.findByRole('button', {
    name: 'All integrations (1)',
  });
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(
    screen.getByRole('heading', { name: 'Unavailable providers' }),
  ).toBeVisible();
  const ai = screen.getByRole('button', { name: 'AI providers (1)' });
  await userEvent.click(ai);
  expect(ai).toHaveAttribute('aria-pressed', 'true');
  expect(all).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('heading', { name: 'AI providers' })).toBeVisible();
  expect(
    screen.queryByRole('heading', { name: 'Unavailable providers' }),
  ).not.toBeInTheDocument();
});
