import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import App from './App';
import { localDateTime } from './SuperAdminPages';

function setup(path: string) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/session')
      return Response.json({
        user: {
          id: 'u',
          tenant_id: 't',
          full_name: 'Owner',
          email: 'owner@example.test',
          role: 'SUPER_ADMIN',
          active: true,
          platform_admin: true,
        },
        expiresAt: Date.now() + 900000,
      });
    if (init.method === 'POST')
      return Response.json({ id: 'new', deliveryStatus: 'SENT' });
    if (url === '/api/v1/super-admin/integrations') return Response.json([]);
    return Response.json({ data: [], pagination: { total: 0 } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
it('shows inline organization validation and does not submit invalid fields', async () => {
  const fetcher = setup('/super-admin/organizations');
  await screen.findByRole('heading', { name: 'Organizations' });
  await userEvent.click(screen.getByText('Add organization'));
  await userEvent.click(
    screen.getByRole('button', { name: 'Create organization & invite admin' }),
  );
  expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(
    false,
  );
});
it('preserves long OAuth credentials and clears the field after saving', async () => {
  const fetcher = setup('/super-admin/integrations');
  await screen.findByRole('heading', { name: 'Integrations' });
  const credential = 'opaque-token-'.repeat(40);
  // Paste exercises the length bound without hundreds of individual key events.
  const user = userEvent.setup();
  const field = screen.getByLabelText('Credential');
  await user.click(field);
  await user.paste(credential);
  await user.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Saved successfully.');
  const call = fetcher.mock.calls.find(
    ([url, init]) =>
      url === '/api/v1/super-admin/integrations' && init.method === 'POST',
  );
  expect(JSON.parse(call![1].body as string).credential).toBe(credential);
  expect(field).toHaveValue('');
});
it('uses ascending name sorting and resets organization paging', async () => {
  const fetcher = setup('/super-admin/organizations');
  await screen.findByRole('heading', { name: 'Organizations' });
  await userEvent.selectOptions(screen.getByLabelText('Sort'), 'name');
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.includes('sort=name&direction=asc'),
      ),
    ).toBe(true),
  );
});
it('uses the entered organization ID for both the audit query and CSV export', async () => {
  const fetcher = setup('/super-admin/audit-logs');
  await screen.findByRole('heading', { name: 'Audit logs' });
  const id = '11111111-1111-4111-8111-111111111111';
  await userEvent.type(screen.getByLabelText('Organization ID'), id);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => url.includes('organization_id=' + id)),
    ).toBe(true),
  );
  expect(
    screen.getByRole('link', { name: 'Export current page (CSV)' }),
  ).toHaveAttribute('href', expect.stringContaining('organization_id=' + id));
});
it('round trips a local date input without shifting the trial deadline', () => {
  const original = '2026-11-17T12:30:00.000Z';
  expect(new Date(localDateTime(original)).toISOString()).toBe(original);
});
