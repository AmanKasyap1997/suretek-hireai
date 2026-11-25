import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationsPage, type Screening } from './Applications';

vi.setConfig({ testTimeout: 20000 });

const auth = vi.hoisted(() => ({ role: 'RECRUITER' }));
vi.mock('./auth', () => ({
  useAuth: () => ({ status: 'ready', session: { user: { role: auth.role } } }),
}));

const row = {
  id: 'app-1',
  job_id: 'job-1',
  candidate_id: 'cand-1',
  stage: 'APPLIED',
  created_at: '2026-11-24T09:00:00Z',
  job_title: 'Full Stack Developer',
  candidate_name: 'Asha Verma',
  current_location: 'Noida',
  total_experience_months: 54,
  notice_period: 'DAYS_30',
  source: 'LINKEDIN',
  screening_status: null as string | null,
  screening_score: null as number | null,
  screening_fit: null as string | null,
  screening_missing_must_have: null as boolean | null,
};
const details = (hidden: boolean, scan = 'PENDING') => ({
  id: 'app-1',
  stage: 'APPLIED',
  created_at: '2026-11-24T09:00:00Z',
  job: { id: 'job-1', title: 'Full Stack Developer' },
  candidate: {
    id: 'cand-1',
    full_name: 'Asha Verma',
    erased: false,
    email: hidden ? null : 'asha@example.com',
    phone: hidden ? null : '+919876543210',
  },
  details: {
    current_location: 'Noida',
    willing_to_relocate: true,
    total_experience_months: 54,
    current_company: 'Acme Software',
    current_title: 'Software Engineer',
    notice_period: 'DAYS_30',
    last_working_day: null,
    current_ctc: hidden ? null : 900000,
    expected_ctc: hidden ? null : 1300000,
    ctc_currency: hidden ? null : 'INR',
    linkedin_url: 'https://www.linkedin.com/in/asha',
    portfolio_url: null,
    cover_letter: 'I build hiring tools.',
    source: 'REFERRAL',
    referrer: 'Rahul Sharma',
  },
  documents: hidden
    ? []
    : [
        {
          id: 'doc-1',
          original_name: 'asha-cv.pdf',
          byte_size: 2048,
          scan_status: scan,
          sent_with: 'this_application',
          created_at: '2026-11-24T09:00:00Z',
        },
      ],
  other_resumes: hidden ? 0 : 1,
  pay_and_contact_hidden: hidden,
});
const completed: Screening = {
  id: 'scr-1',
  status: 'COMPLETED',
  trigger: 'AUTOMATIC',
  score: 63,
  fit: 'PARTIAL',
  missing_must_have: true,
  result: {
    criteria: [
      {
        id: 'c1',
        label: '3+ years of React',
        weight: 3,
        must_have: true,
        rating: 'MEETS',
        evidence: 'Built React dashboards for 4 years',
        reason: 'Four years of React.',
      },
      {
        id: 'c2',
        label: 'AWS certification',
        weight: 1,
        must_have: true,
        rating: 'NOT_MET',
        evidence: '',
        reason: 'No certification listed.',
      },
    ],
    derived_criteria: false,
    summary: 'A frontend engineer with four years of React.',
    strengths: ['Production React experience'],
    concerns: ['No AWS certification'],
    questions: ['Which AWS services have you used?'],
    instructions_in_resume: true,
  },
  provider_label: 'Anthropic',
  document_name: 'asha-cv.pdf',
  fallback_message:
    'Anthropic screened this resume because OpenAI couldn’t be used. Your organization’s OpenAI account has run out of credits or reached its usage limit.',
  model: 'claude-opus-5-5',
  failure_message: null,
  created_at: '2026-11-24T09:01:00Z',
  completed_at: '2026-11-24T09:01:30Z',
  outdated: false,
};

interface Options {
  hidden?: boolean;
  scan?: string;
  role?: string;
  screening?: Screening | null;
  listed?: Partial<typeof row>;
}

function setup({
  hidden = false,
  scan = 'PENDING',
  role = 'RECRUITER',
  screening = null,
  listed = {},
}: Options = {}) {
  auth.role = role;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url.startsWith('/api/v1/applications?'))
        return Response.json({ data: [{ ...row, ...listed }], total: 1 });
      if (url.startsWith('/api/v1/jobs?'))
        return Response.json({
          data: [
            { id: 'job-1', title: 'Full Stack Developer', status: 'PUBLISHED' },
          ],
          total: 1,
        });
      if (url === '/api/v1/jobs/job-1/screening' && method === 'GET')
        return Response.json({
          total: 5,
          screened: 2,
          in_progress: 0,
          failed: 0,
          to_screen: 3,
          auto_screen: true,
          ai_available: true,
        });
      if (url === '/api/v1/jobs/job-1/screening')
        return Response.json({ queued: 2, skipped: 1 }, { status: 202 });
      if (url === '/api/v1/applications/app-1/details')
        return Response.json(details(hidden, scan));
      if (url === '/api/v1/applications/app-1/screening' && method === 'GET')
        return Response.json({ screening });
      if (url === '/api/v1/applications/app-1/screening')
        return Response.json({ screening: completed });
      if (url === '/api/v1/applications/app-1/stage')
        return Response.json({ id: 'app-1' });
      if (url.endsWith('/documents/doc-1/download'))
        return new Response(new Blob(['%PDF-1.7']), { status: 200 });
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ApplicationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetcher;
}

const requests = (fetcher: ReturnType<typeof setup>, path: string) =>
  fetcher.mock.calls.filter(
    ([url, init]) => String(url) === path && init?.method,
  );

async function openApplication() {
  await userEvent.click(
    await screen.findByRole('button', {
      name: 'View application from Asha Verma',
    }),
  );
  return screen.findByRole('dialog', { name: 'Asha Verma' });
}

afterEach(() => vi.unstubAllGlobals());

it('lists applicants with what they entered on the apply form', async () => {
  setup();
  const table = await screen.findByRole('table');
  const cells = within(table)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
  expect(cells).toEqual(
    expect.arrayContaining([
      'Asha VermaNoida',
      'Full Stack Developer',
      'Not screened',
      '4 yrs 6 mo',
      '1 month',
      'LinkedIn',
      'Applied',
    ]),
  );
});

it('shows the AI match and sorts by best match', async () => {
  const fetcher = setup({
    listed: {
      screening_status: 'COMPLETED',
      screening_score: 63,
      screening_fit: 'PARTIAL',
      screening_missing_must_have: true,
    },
  });
  const table = await screen.findByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'AI match' }));
  expect(
    within(table).getByLabelText('Match score 63 out of 100'),
  ).toBeVisible();
  expect(within(table).getByText('Missing a must-have')).toBeVisible();
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Sort applications' }),
    'score',
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes('sort=score')),
    ).toBe(true),
  );
});

it('shows recruiters contact details, pay and the resume', async () => {
  setup();
  const dialog = await openApplication();
  await within(dialog).findByText('asha@example.com');
  expect(within(dialog).getByText('₹9,00,000')).toBeVisible();
  expect(within(dialog).getByText('₹13,00,000')).toBeVisible();
  expect(
    within(dialog).getByText('Software Engineer at Acme Software'),
  ).toBeVisible();
  expect(
    within(dialog).getByText('Employee referral · referred by Rahul Sharma'),
  ).toBeVisible();
  expect(within(dialog).getByText('I build hiring tools.')).toBeVisible();
  // Unscanned resumes can't be downloaded yet.
  expect(within(dialog).getByText('Waiting for the virus scan')).toBeVisible();
  // Only the resume sent with this application is listed.
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
  expect(
    within(dialog).getByText(/The candidate has 1 other resume/),
  ).toBeVisible();
  expect(
    within(dialog).getByRole('button', { name: 'Download' }),
  ).toBeDisabled();
});

it('downloads a scanned resume', async () => {
  const fetcher = setup({ scan: 'CLEAN' });
  const created = vi.fn(() => 'blob:resume');
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  const dialog = await openApplication();
  await userEvent.click(
    await within(dialog).findByRole('button', { name: 'Download' }),
  );
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).endsWith('/candidates/cand-1/documents/doc-1/download'),
    ),
  ).toBe(true);
  click.mockRestore();
});

it('shows the AI screening with evidence, flags and who screened it', async () => {
  setup({ screening: completed });
  const dialog = await openApplication();
  const panel = await within(dialog).findByRole('region', {
    name: 'AI screening',
  });
  expect(await within(panel).findByText('63')).toBeVisible();
  expect(within(panel).getByText('Partial match')).toBeVisible();
  expect(within(panel).getByText('Meets 1 of 2 requirements')).toBeVisible();
  expect(
    within(panel).getByText(/Missing a must-have: AWS certification/),
  ).toBeVisible();
  expect(
    within(panel).getByText(/tries to instruct AI screeners/),
  ).toBeVisible();
  expect(
    within(panel).getByText('Built React dashboards for 4 years'),
  ).toBeVisible();
  expect(within(panel).getByText('Not met')).toBeVisible();
  expect(
    within(panel).getByText('Which AWS services have you used?'),
  ).toBeVisible();
  expect(
    within(panel).getByText(
      /Screened asha-cv\.pdf with Anthropic \(claude-opus-5-5\)/,
    ),
  ).toBeVisible();
  // A provider without credits was skipped, and the panel says so.
  expect(
    within(panel).getByText(/because OpenAI couldn’t be used/),
  ).toBeVisible();
  expect(
    within(panel).getByRole('button', { name: 'Screen again' }),
  ).toBeVisible();
});

it('screens a resume on request', async () => {
  const fetcher = setup();
  const dialog = await openApplication();
  const panel = await within(dialog).findByRole('region', {
    name: 'AI screening',
  });
  expect(await within(panel).findByText('Not screened yet.')).toBeVisible();
  await userEvent.click(
    within(panel).getByRole('button', { name: 'Screen resume' }),
  );
  expect(await within(panel).findByText('Partial match')).toBeVisible();
  expect(
    requests(fetcher, '/api/v1/applications/app-1/screening')[0][1]?.method,
  ).toBe('POST');
});

it('explains a failed screening and offers to screen again', async () => {
  setup({
    screening: {
      ...completed,
      status: 'FAILED',
      score: null,
      fit: null,
      result: null,
      failure_message:
        'Your organization’s Anthropic account has run out of credits.',
    },
  });
  const dialog = await openApplication();
  expect(await within(dialog).findByText(/run out of credits/)).toBeVisible();
  expect(
    within(dialog).getByRole('button', { name: 'Screen again' }),
  ).toBeVisible();
});

it('lets hiring managers read screenings and shortlist, but not run them', async () => {
  const fetcher = setup({ role: 'HIRING_MANAGER', screening: completed });
  const dialog = await openApplication();
  expect(await within(dialog).findByText('Partial match')).toBeVisible();
  expect(
    within(dialog).queryByRole('button', { name: 'Screen again' }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Shortlist' }),
  );
  expect(
    await within(dialog).findByText('Moved to Shortlisted.'),
  ).toBeVisible();
  const [, init] = requests(fetcher, '/api/v1/applications/app-1/stage')[0];
  expect(init?.method).toBe('PATCH');
  expect(JSON.parse(String(init?.body))).toEqual({ stage: 'SHORTLISTED' });
});

it('asks for a reason before rejecting', async () => {
  const fetcher = setup();
  const dialog = await openApplication();
  await userEvent.click(
    await within(dialog).findByRole('button', { name: 'Reject…' }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Reject application' }),
  );
  expect(
    within(dialog).getByText('Choose a reason for rejecting.'),
  ).toBeVisible();
  await userEvent.selectOptions(
    within(dialog).getByRole('combobox', { name: 'Reason' }),
    'EXPERIENCE',
  );
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Note (optional)' }),
    'Needs more backend work',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Reject application' }),
  );
  expect(
    await within(dialog).findByText('Application rejected.'),
  ).toBeVisible();
  const [, init] = requests(fetcher, '/api/v1/applications/app-1/stage')[0];
  expect(JSON.parse(String(init?.body))).toEqual({
    stage: 'REJECTED',
    reasonCode: 'EXPERIENCE',
    note: 'Needs more backend work',
  });
});

it('screens a job’s unscreened applications in bulk', async () => {
  const fetcher = setup();
  await screen.findByRole('option', { name: 'Full Stack Developer' });
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Filter by job' }),
    'job-1',
  );
  expect(await screen.findByText(/2 of 5 applications screened/)).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Screen 3 unscreened applications' }),
  );
  expect(
    await screen.findByText(
      /Screening 2 applications\..*1 application couldn’t be screened, usually because there’s no usable resume\./,
    ),
  ).toBeVisible();
  expect(requests(fetcher, '/api/v1/jobs/job-1/screening')[0][1]?.method).toBe(
    'POST',
  );
});

it('hides screenings, pay and contact details from interviewers', async () => {
  setup({ hidden: true, role: 'INTERVIEWER' });
  const table = await screen.findByRole('table');
  expect(
    within(table).queryByRole('columnheader', { name: 'AI match' }),
  ).not.toBeInTheDocument();
  const dialog = await openApplication();
  expect(
    await within(dialog).findByText(/Pay, contact details and the resume/),
  ).toBeVisible();
  expect(
    within(dialog).queryByRole('heading', { name: 'Contact' }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole('heading', { name: 'Pay (annual CTC)' }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole('region', { name: 'AI screening' }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole('heading', { name: 'Decision' }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText('4 yrs 6 mo')).toBeVisible();
});
