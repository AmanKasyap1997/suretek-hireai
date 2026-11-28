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
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: unknown;
      let status = role ? 200 : 401;
      if (url.includes('/super-admin/dashboard')) {
        body = { attention: [], recent_events: [], total_organizations: 0 };
      } else if (url.includes('/auth/session') && role) {
        body = { ...session(role), ...(expiresAt ? { expiresAt } : {}) };
      } else if (url.includes('/jobs') && method === 'POST') {
        const draft = JSON.parse(String(init?.body ?? '{}'));
        body = {
          ...draft,
          id: 'job-1',
          status: 'DRAFT',
          employment_type: draft.employmentType,
          salary_min: draft.salaryMin,
          salary_max: draft.salaryMax,
          screening_criteria: draft.screeningCriteria,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        };
        status = 201;
      } else if (
        url.includes('/jobs') ||
        url.includes('/applications') ||
        url.includes('/candidates') ||
        url.includes('/interviews')
      ) {
        body = {
          data: url.includes('/jobs')
            ? [
                {
                  id: 'job-activity',
                  title: 'Senior PHP Developer',
                  department: 'Engineering',
                  location: 'Delhi-NCR',
                  employment_type: 'FULL_TIME',
                  openings: 1,
                  status: 'PUBLISHED',
                  updated_at: new Date().toISOString(),
                },
              ]
            : url.includes('/applications')
              ? [
                  {
                    id: 'application-activity',
                    candidate_name: 'Rahul Sharma',
                    job_title: 'Senior PHP Developer',
                    created_at: new Date(Date.now() - 60_000).toISOString(),
                  },
                ]
              : url.includes('/interviews')
                ? [
                    {
                      id: 'interview-activity',
                      application_id: 'application-activity',
                      starts_at: new Date(
                        Date.now() + 86_400_000,
                      ).toISOString(),
                      ends_at: new Date(Date.now() + 90_000_000).toISOString(),
                      created_at: new Date(Date.now() - 120_000).toISOString(),
                      panelist_ids: ['panelist-1'],
                      mode: 'ONLINE',
                      status: 'SCHEDULED',
                    },
                  ]
                : [],
          total:
            url.includes('/jobs') ||
            url.includes('/applications') ||
            url.includes('/interviews')
              ? 1
              : 0,
          pagination: { limit: 25, offset: 0 },
        };
      } else if (url.includes('/reports/recruitment/funnel')) {
        body = {
          data: [
            { stage: 'APPLIED', applicationCount: 2 },
            { stage: 'APPLIED', applicationCount: 3 },
          ],
        };
      } else {
        body = role ? session(role) : {};
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
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
              : ['HR_ADMIN', 'RECRUITER'].includes(role)
                ? /Welcome back, Test/
                : // Their own home: jobs, applicants, interviews, feedback.
                  ['HIRING_MANAGER', 'INTERVIEWER'].includes(role)
                  ? 'Welcome, Test'
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
  it('shows the Jobs page to organization admins', async () => {
    setup('/jobs', 'HR_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeVisible();
  });
  it('aggregates recruitment funnel rows across jobs', async () => {
    setup(homePath('HR_ADMIN'), 'HR_ADMIN');
    await screen.findByRole('heading', { name: 'Recruitment funnel' });
    expect(screen.getAllByText('5')).toHaveLength(2);
  });
  it('shows recent applications and upcoming interview details', async () => {
    setup(homePath('HR_ADMIN'), 'HR_ADMIN');
    expect(
      await screen.findByText('New application — Rahul Sharma'),
    ).toBeVisible();
    expect(screen.getByText('1 assigned')).toBeVisible();
    expect(screen.getByText('online')).toBeVisible();
  });
  it('validates required job details before continuing', async () => {
    setup('/jobs', 'HR_ADMIN');
    await screen.findByRole('heading', { name: 'Jobs' });
    await userEvent.click(screen.getAllByRole('button', { name: /Create/ })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a job title.',
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).includes('/jobs') && init?.method === 'POST',
        ),
    ).toBe(false);
  });
  it('saves a complete job as a draft', async () => {
    setup('/jobs', 'HR_ADMIN');
    await screen.findByRole('heading', { name: 'Jobs' });
    await userEvent.click(screen.getAllByRole('button', { name: /Create/ })[0]);
    await userEvent.type(screen.getByLabelText(/Job title/), 'Recruiter');
    await userEvent.type(screen.getByLabelText(/Department/), 'People');
    await userEvent.type(screen.getByLabelText(/Location/), 'Remote');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.type(
      screen.getByLabelText(/Description/),
      'Own recruitment from intake through offer.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Recruiter was saved as a draft.',
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).includes('/jobs') && init?.method === 'POST',
        ),
    ).toBe(true);
    // Typing through the whole builder takes about 5s on a busy machine.
  }, 20000);
  it('protects the Jobs page from roles without recruitment access', async () => {
    setup('/jobs', 'EMPLOYEE');
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
    await screen.findByRole('heading', { name: /Welcome back, Test/ });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await userEvent.click(screen.getByText('Test person'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(cache.getQueryData(['private'])).toBeUndefined();
  });
  it('any API 401 expires the session and clears cache', async () => {
    const cache = setup('/', 'HR_ADMIN');
    await screen.findByRole('heading', { name: /Welcome back, Test/ });
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
