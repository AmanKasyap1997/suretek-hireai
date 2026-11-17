import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import App from './App';
import type { Role } from './permissions';
const token = 'a'.repeat(43);
function setup(role: Role, path: string, postStatus = 201) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/session')
      return new Response(
        JSON.stringify({
          user: {
            id: 'u',
            tenant_id: 't',
            full_name: 'Test user',
            email: 'test@console.test',
            role,
            active: true,
          },
          expiresAt: Date.now() + 900000,
        }),
        { status: 200 },
      );
    if (init.method === 'POST')
      return new Response(
        JSON.stringify({
          deliveryStatus: postStatus === 201 ? 'FAILED' : undefined,
        }),
        { status: postStatus },
      );
    return new Response(
      JSON.stringify({
        data: [],
        pagination: { limit: 25, offset: 0, total: 0 },
      }),
      { status: 200 },
    );
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
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
it('gives Super Admin organization provisioning only and reports email failure accurately', async () => {
  const fetcher = setup('SUPER_ADMIN', '/organizations');
  await screen.findByRole('heading', { name: 'Organizations' });
  expect(screen.getByRole('navigation')).not.toHaveTextContent('Jobs');
  expect(screen.queryByLabelText('Password')).toBeNull();
  await screen.findByText(
    'No organizations yet. Create your first organization to get started.',
  );
  await userEvent.type(screen.getByLabelText('Organization name'), 'Acme');
  await userEvent.type(screen.getByLabelText('Organization key'), 'acme');
  await userEvent.type(
    screen.getByLabelText('Admin name'),
    'Acme administrator',
  );
  await userEvent.type(screen.getByLabelText('Admin email'), 'admin@acme.test');
  await userEvent.click(
    screen.getByRole('button', { name: 'Create organization & invite admin' }),
  );
  await screen.findByText(
    /Organization created, but the invitation email could not be sent/,
  );
  const request = fetcher.mock.calls.find(
    ([url, init]) =>
      url === '/api/v1/saas/organizations' && init.method === 'POST',
  );
  expect(JSON.parse(request![1].body as string)).toEqual({
    name: 'Acme',
    slug: 'acme',
    adminName: 'Acme administrator',
    adminEmail: 'admin@acme.test',
  });
});
it('lets an organization admin invite staff without offering platform or admin escalation', async () => {
  const fetcher = setup('HR_ADMIN', '/team');
  await screen.findByRole('heading', { name: 'Team & invitations' });
  await screen.findByText('No team members yet.');
  expect(screen.queryByRole('option', { name: 'Super Admin' })).toBeNull();
  expect(
    screen.queryByRole('option', { name: 'Organization Admin' }),
  ).toBeNull();
  await userEvent.type(screen.getByLabelText('Full name'), 'Hiring lead');
  await userEvent.type(screen.getByLabelText('Email'), 'lead@acme.test');
  await userEvent.selectOptions(
    screen.getByLabelText('Role'),
    'HIRING_MANAGER',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Send invitation' }),
  );
  await screen.findByText(
    'Account invited, but email delivery failed. Retry from the team list.',
  );
  const request = fetcher.mock.calls.find(
    ([url, init]) =>
      url === '/api/v1/saas/invitations' && init.method === 'POST',
  );
  expect(JSON.parse(request![1].body as string)).toEqual({
    fullName: 'Hiring lead',
    email: 'lead@acme.test',
    role: 'HIRING_MANAGER',
  });
});
it('keeps the platform user out of direct recruitment URLs', async () => {
  setup('SUPER_ADMIN', '/jobs');
  expect(
    await screen.findByRole('heading', { name: 'Not permitted' }),
  ).toBeVisible();
});
it('removes the invitation fragment, validates confirmation and sends no client role', async () => {
  const path = `/accept-invitation#organization=acme&token=${token}`;
  window.history.replaceState(null, '', `/console${path}`);
  const fetcher = setup('EMPLOYEE', path, 200);
  await screen.findByRole('heading', { name: 'Accept your invitation' });
  expect(window.location.hash).toBe('');
  await userEvent.type(
    screen.getByLabelText('Create password', { exact: true }),
    'A-new-password-2026!',
  );
  await userEvent.type(
    screen.getByLabelText('Confirm password', { exact: true }),
    'different',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Accept invitation & set password' }),
  );
  expect(await screen.findByText('Passwords must match.')).toBeVisible();
  expect(
    fetcher.mock.calls.some(
      ([url, init]) =>
        url === '/api/v1/saas/invitations/accept' && init.method === 'POST',
    ),
  ).toBe(false);
  await userEvent.clear(
    screen.getByLabelText('Confirm password', { exact: true }),
  );
  await userEvent.type(
    screen.getByLabelText('Confirm password', { exact: true }),
    'A-new-password-2026!',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Accept invitation & set password' }),
  );
  await screen.findByRole('heading', { name: 'Invitation accepted' });
  const request = fetcher.mock.calls.find(
    ([url, init]) =>
      url === '/api/v1/saas/invitations/accept' && init.method === 'POST',
  );
  expect(JSON.parse(request![1].body as string)).toEqual({
    organizationSlug: 'acme',
    token,
    password: 'A-new-password-2026!',
  });
  expect(Object.keys(localStorage)).toEqual([]);
  expect(Object.keys(sessionStorage)).toEqual([]);
});
it('shows an actionable expired/replaced invitation error', async () => {
  setup('EMPLOYEE', `/accept-invitation#organization=acme&token=${token}`, 400);
  await screen.findByRole('heading', { name: 'Accept your invitation' });
  for (const label of ['Create password', 'Confirm password'])
    await userEvent.type(
      screen.getByLabelText(label, { exact: true }),
      'A-new-password-2026!',
    );
  await userEvent.click(
    screen.getByRole('button', { name: 'Accept invitation & set password' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ask your administrator for a new invitation.',
    ),
  );
  expect(
    screen.queryByRole('heading', { name: 'Invitation accepted' }),
  ).toBeNull();
});
