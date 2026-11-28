import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JobBuilder, JobsPage, type JobRole } from './Jobs';

vi.setConfig({ testTimeout: 20000 });

let role: JobRole = 'HR_ADMIN';
vi.mock('./auth', () => ({
  useAuth: () => ({
    status: 'ready',
    session: {
      user: { role, id: 'u1', full_name: 'Test', organization_slug: 'acme' },
    },
  }),
}));

type Status = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'CLOSED';
const job = (status: Status, extra: object = {}) => ({
  id: 'job-1',
  title: 'Data Analyst',
  description: 'Turn hiring data into weekly decisions.',
  department: 'Analytics',
  location: 'Noida',
  status,
  openings: 1,
  employment_type: 'FULL_TIME',
  salary_min: null,
  salary_max: null,
  screening_criteria: [],
  requested_at: null as string | null,
  review_note: null as string | null,
  created_by_name: 'Meera Manager',
  created_at: '2026-11-20T09:00:00Z',
  updated_at: '2026-11-20T09:00:00Z',
  ...extra,
});

let listed: ReturnType<typeof job>[];
/** The status a saved job comes back with. */
let saved: Status;
/** AI calling is on: jobs have call questions. */
let calling: boolean;
let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  role = 'HR_ADMIN';
  calls = [];
  listed = [];
  saved = 'DRAFT';
  calling = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status });
      if (url.endsWith('/jobs/ai-description/providers')) return json([]);
      if (url.endsWith('/jobs/call-questions/settings'))
        return json({ enabled: calling, ai_available: calling });
      if (url.endsWith('/jobs/call-questions') && method === 'POST')
        return json({
          questions: [
            {
              id: 'q1',
              text: 'Have you built dashboards in Power BI?',
              answer_type: 'yes_no',
              expected_answer: 'yes',
              criterion_id: null,
            },
          ],
          label: 'OpenAI',
          environment: 'production',
        });
      if (url.endsWith('/jobs/publishing/channels')) return json([]);
      if (url.startsWith('/api/v1/jobs?'))
        return json({ data: listed, total: listed.length });
      if (url === '/api/v1/jobs' && method === 'POST')
        return json(job('DRAFT'), 201);
      if (url === '/api/v1/jobs/job-1' && method === 'PATCH')
        return json(job(saved));
      if (url.endsWith('/submit'))
        return json(job('DRAFT', { requested_at: '2026-11-27T09:00:00Z' }));
      if (url.endsWith('/send-back'))
        return json(job('DRAFT', { review_note: body.note }));
      if (url.endsWith('/publish')) return json(job('PUBLISHED'));
      if (url.endsWith('/channels')) return json({ results: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(children: ReactNode) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

async function toLastStep() {
  for (let i = 0; i < 3; i++)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

it('lets a hiring manager request a job and submit it for approval', async () => {
  const onSaved = vi.fn();
  renderWith(
    <JobBuilder
      initialJob={null}
      role="HIRING_MANAGER"
      onCancel={() => undefined}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Request a Job' })).toBeVisible();
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job title/ }),
    'Data Analyst',
  );
  await userEvent.type(
    screen.getByRole('combobox', { name: /Department/ }),
    'Analytics',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Location/ }),
    'Noida',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job description/ }),
    'Turn hiring data into weekly decisions.',
  );
  await toLastStep();
  expect(screen.getByText('Next: an HR Admin approves it.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Publish Job' })).toBeNull();
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit for approval' }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
    expect.arrayContaining([
      'POST /api/v1/jobs',
      'POST /api/v1/jobs/job-1/submit',
    ]),
  );
  expect(onSaved.mock.calls[0][0].requested_at).toBeTruthy();
});

it('lets a hiring manager add the AI call questions to a request', async () => {
  calling = true;
  renderWith(
    <JobBuilder
      initialJob={null}
      role="HIRING_MANAGER"
      onCancel={() => undefined}
      onSaved={() => undefined}
    />,
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job title/ }),
    'Data Analyst',
  );
  await userEvent.type(
    screen.getByRole('combobox', { name: /Department/ }),
    'Analytics',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Location/ }),
    'Noida',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job description/ }),
    'Turn hiring data into weekly decisions.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Drafted with AI on reaching the step, for them to edit.
  expect(
    await screen.findByDisplayValue('Have you built dashboards in Power BI?'),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit for approval' }),
  );
  await waitFor(() =>
    expect(
      calls.find((c) => c.url === '/api/v1/jobs' && c.method === 'POST')?.body,
    ).toMatchObject({
      callQuestions: [
        { id: 'q1', text: 'Have you built dashboards in Power BI?' },
      ],
    }),
  );
});

it('shows why an HR Admin sent a request back', () => {
  renderWith(
    <JobBuilder
      initialJob={job('DRAFT', { review_note: 'Add the salary range.' })}
      role="HIRING_MANAGER"
      onCancel={() => undefined}
      onSaved={() => undefined}
    />,
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'Sent back by an HR Admin: Add the salary range. Make the changes, then submit it again.',
  );
});

it('lets a recruiter publish an approved job, choosing the channels', async () => {
  saved = 'APPROVED';
  const onSaved = vi.fn();
  renderWith(
    <JobBuilder
      initialJob={job('APPROVED')}
      role="RECRUITER"
      onCancel={() => undefined}
      onSaved={onSaved}
    />,
  );
  await toLastStep();
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith('/jobs/publishing/channels'))).toBe(
      true,
    ),
  );
  expect(
    screen.queryByRole('button', { name: 'Submit for approval' }),
  ).toBeNull();
  // Recruiters choose where it's posted, as HR Admins do.
  await userEvent.click(
    await screen.findByRole('checkbox', { name: 'Only in HireAI' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(onSaved.mock.calls[0][1]).toBe(true);
  expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
  expect(calls.some((c) => c.url.endsWith('/job-1/publish'))).toBe(true);
});

it('keeps a recruiter to approved jobs: drafts are view only', async () => {
  role = 'RECRUITER';
  listed = [
    job('DRAFT', { requested_at: '2026-11-27T09:00:00Z' }),
    job('APPROVED', { id: 'job-2', title: 'Full Stack Developer' }),
  ];
  renderWith(<JobsPage />);
  const draft = (await screen.findByText('Data Analyst')).closest('tr')!;
  expect(
    within(draft).getByText(
      'Requested by Meera Manager · waiting for HR Admin approval',
    ),
  ).toBeVisible();
  expect(within(draft).queryByRole('button', { name: /Edit/ })).toBeNull();
  expect(
    within(draft).queryByRole('button', { name: /Interview booking/ }),
  ).toBeNull();
  expect(within(draft).queryByRole('button', { name: /Submit/ })).toBeNull();
  const approved = screen.getByText('Full Stack Developer').closest('tr')!;
  expect(
    within(approved).getByRole('button', {
      name: 'Edit Full Stack Developer',
    }),
  ).toBeVisible();
  expect(
    within(approved).getByRole('button', { name: 'Publish' }),
  ).toBeVisible();
  // Hiring managers request jobs; recruiters don't create them.
  expect(screen.queryByRole('button', { name: /Create Job/ })).toBeNull();
});

it('tells a recruiter with no jobs where jobs come from, with no create button', async () => {
  role = 'RECRUITER';
  listed = [];
  renderWith(<JobsPage />);
  expect(
    await screen.findByText(
      /Jobs appear here once a Hiring Manager requests one and an HR Admin approves it/,
    ),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
});

it('offers a hiring manager with no jobs to request one', async () => {
  role = 'HIRING_MANAGER';
  listed = [];
  renderWith(<JobsPage />);
  expect(
    await screen.findByRole('button', { name: /Request your first job/ }),
  ).toBeVisible();
});

it('lets an HR Admin approve a request or send it back with a note', async () => {
  listed = [job('DRAFT', { requested_at: '2026-11-27T09:00:00Z' })];
  renderWith(<JobsPage />);
  const row = (await screen.findByText('Data Analyst')).closest('tr')!;
  expect(within(row).getByText('Awaiting approval')).toBeVisible();
  expect(within(row).getByText('Requested by Meera Manager')).toBeVisible();
  expect(within(row).getByRole('button', { name: 'Approve' })).toBeVisible();
  await userEvent.click(within(row).getByRole('button', { name: 'Send back' }));
  const dialog = await screen.findByRole('dialog', { name: 'Send back' });
  await userEvent.type(
    within(dialog).getByLabelText('What should change?'),
    'Add the salary range.',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Send back' }),
  );
  expect(
    await screen.findByText(
      'Data Analyst was sent back to Meera Manager with your note.',
    ),
  ).toBeVisible();
  expect(calls.find((c) => c.url.endsWith('/send-back'))?.body).toEqual({
    note: 'Add the salary range.',
  });
});

it('lets a hiring manager request jobs and submit drafts from the list', async () => {
  role = 'HIRING_MANAGER';
  listed = [job('DRAFT')];
  renderWith(<JobsPage />);
  expect(
    await screen.findByRole('button', { name: /Request a Job/ }),
  ).toBeVisible();
  const row = (await screen.findByText('Data Analyst')).closest('tr')!;
  expect(
    within(row).getByText('Submit it for approval when it’s ready'),
  ).toBeVisible();
  expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
  await userEvent.click(
    within(row).getByRole('button', {
      name: 'Submit Data Analyst for approval',
    }),
  );
  expect(
    await screen.findByText(/Data Analyst was submitted for approval/),
  ).toBeVisible();
});
