import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ApplyPage,
  CareersJobsPage,
  formatExperience,
  normalizePhone,
} from './Careers';

vi.setConfig({ testTimeout: 30000 });

const job = {
  id: 'job-1',
  title: 'Full Stack Developer',
  description: 'About the role:\nBuild hiring tools.',
  department: 'Engineering',
  location: 'Noida',
  employment_type: 'FULL_TIME',
  openings: 2,
  created_at: '2026-11-20T09:00:00Z',
  organization: { name: 'Suretek Infosoft' },
  noticeVersion: '2026-11-v1',
  resumeMaxBytes: 5 * 1024 * 1024,
  captcha: null,
};

function setup(path: string, apply?: () => Response) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST')
        return apply?.() ?? Response.json({ message: 'ok' }, { status: 202 });
      if (url.endsWith('/public/suretek/jobs?limit=100'))
        return Response.json({
          data: [job],
          total: 1,
          pagination: { limit: 100, offset: 0 },
          ...job,
        });
      if (url.endsWith('/public/suretek/jobs/job-1')) return Response.json(job);
      return Response.json({ message: 'Job not found' }, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/careers/:slug" element={<CareersJobsPage />} />
          <Route path="/careers/:slug/jobs/:id" element={<ApplyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const posts = () =>
    fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { fetcher, posts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function fillRequired() {
  await userEvent.type(screen.getByLabelText(/^Full name/), 'Asha Verma');
  await userEvent.type(screen.getByLabelText(/^Email/), 'asha@example.com');
  await userEvent.type(screen.getByLabelText(/^Phone/), '+91 98765 43210');
  await userEvent.type(screen.getByLabelText(/^Current city/), 'Noida');
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Years' }),
    '4',
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Months' }),
    '6',
  );
  await userEvent.selectOptions(
    screen.getByLabelText(/^Notice period/),
    'DAYS_30',
  );
  await userEvent.type(
    screen.getByLabelText(/^Expected annual CTC/),
    '1300000',
  );
  await userEvent.upload(
    screen.getByLabelText(/^Resume/),
    new File(['%PDF-1.7'], 'asha-cv.pdf', { type: 'application/pdf' }),
  );
  await userEvent.click(screen.getByRole('checkbox', { name: /I agree/ }));
}

it('lists open jobs and keeps the link source when opening one', async () => {
  setup('/careers/suretek?source=linkedin');
  expect(
    await screen.findByRole('heading', {
      name: 'Open jobs at Suretek Infosoft',
    }),
  ).toBeVisible();
  expect(screen.getByText('1 open job')).toBeVisible();
  expect(
    screen.getByRole('link', { name: 'View and apply: Full Stack Developer' }),
  ).toHaveAttribute('href', '/careers/suretek/jobs/job-1?source=linkedin');
});

it('lists every problem before sending anything', async () => {
  const { posts } = setup('/careers/suretek/jobs/job-1');
  await screen.findByRole('heading', { name: 'Full Stack Developer' });
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit application' }),
  );
  const summary = await screen.findByRole('alert');
  expect(summary).toHaveTextContent('Fix 9 things to send your application');
  for (const message of [
    'Enter your full name.',
    'Enter your phone number.',
    'Choose your total work experience.',
    'Choose your notice period.',
    'Enter the annual pay you expect.',
    'Attach your resume.',
    'Agree to the privacy notice to apply.',
  ])
    expect(within(summary).getByRole('link', { name: message })).toBeVisible();
  expect(screen.getByLabelText(/^Full name/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(posts()).toEqual([]);
});

it('sends the form and resume to HireAI as one application', async () => {
  const { posts } = setup('/careers/suretek/jobs/job-1?source=linkedin');
  await screen.findByRole('heading', { name: 'Full Stack Developer' });
  // The shared link already says where the candidate came from.
  expect(
    screen.getByLabelText('How did you hear about this job? (optional)'),
  ).toHaveValue('LINKEDIN');
  await fillRequired();
  expect(screen.getByText('₹13,00,000 a year')).toBeVisible();
  await userEvent.selectOptions(
    screen.getByLabelText(/^Notice period/),
    'SERVING_NOTICE',
  );
  await userEvent.type(
    screen.getByLabelText(/^Last working day/),
    '2026-12-31',
  );
  await userEvent.type(
    screen.getByLabelText(/^LinkedIn profile/),
    'https://www.linkedin.com/in/asha',
  );
  await userEvent.click(screen.getByRole('radio', { name: 'Yes' }));
  // No separate call choices: the privacy notice says calls may happen.
  expect(
    screen.queryByRole('checkbox', { name: /may call me/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/may call you about this application, including a short/),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit application' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Application sent' }),
  ).toHaveFocus();
  expect(posts()).toHaveLength(1);
  const [url, init] = posts()[0];
  expect(String(url)).toBe('/api/v1/public/suretek/jobs/job-1/applications');
  expect(init?.credentials).toBe('omit');
  const body = init?.body as FormData;
  expect(JSON.parse(String(body.get('application')))).toEqual({
    fullName: 'Asha Verma',
    email: 'asha@example.com',
    phone: '+919876543210',
    currentLocation: 'Noida',
    willingToRelocate: true,
    totalExperienceMonths: 54,
    currentTitle: '',
    currentCompany: '',
    noticePeriod: 'SERVING_NOTICE',
    lastWorkingDay: '2026-12-31',
    expectedCtc: 1300000,
    ctcCurrency: 'INR',
    linkedinUrl: 'https://www.linkedin.com/in/asha',
    portfolioUrl: '',
    coverLetter: '',
    source: 'LINKEDIN',
    website: '',
    noticeVersion: '2026-11-v1',
    privacyAccepted: true,
  });
  expect((body.get('resume') as File).name).toBe('asha-cv.pdf');
  // A repeat keeps the first application; the page says so without knowing.
  expect(
    screen.getByText(/Already applied for this job with this email\?/),
  ).toBeVisible();
  expect(localStorage.getItem('hireai-applied:suretek:job-1')).not.toBeNull();
});

it('shows the server’s answer next to the field it is about', async () => {
  setup('/careers/suretek/jobs/job-1', () =>
    Response.json(
      {
        message: 'Validation failed',
        errors: [{ path: 'totalExperienceMonths', message: 'Too large' }],
      },
      { status: 400 },
    ),
  );
  await screen.findByRole('heading', { name: 'Full Stack Developer' });
  await fillRequired();
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit application' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Too large');
  expect(
    screen.queryByRole('heading', { name: 'Application sent' }),
  ).not.toBeInTheDocument();
});

it('refuses a resume that is not a PDF or Word file', async () => {
  const { posts } = setup('/careers/suretek/jobs/job-1');
  await screen.findByRole('heading', { name: 'Full Stack Developer' });
  await fillRequired();
  await userEvent.upload(
    screen.getByLabelText(/^Resume/),
    new File(['x'], 'photo.png', { type: 'image/png' }),
    { applyAccept: false },
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Submit application' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Upload a PDF or Word (.docx) file.',
  );
  expect(posts()).toEqual([]);
});

it('shows this browser’s earlier application instead of the form', async () => {
  localStorage.setItem(
    'hireai-applied:suretek:job-1',
    '2026-11-24T09:00:00.000Z',
  );
  const { posts } = setup('/careers/suretek/jobs/job-1');
  expect(
    await screen.findByRole('heading', {
      name: 'You’ve already applied for this job',
    }),
  ).toBeVisible();
  expect(
    screen.getByText(/Suretek Infosoft has your application/),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Submit application' }),
  ).not.toBeInTheDocument();
  // Someone else on a shared computer can still apply.
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply with a different email' }),
  );
  expect(
    screen.getByRole('button', { name: 'Submit application' }),
  ).toBeVisible();
  expect(posts()).toEqual([]);
});

it('shows the form when browser storage is unavailable', async () => {
  const blocked = vi
    .spyOn(Storage.prototype, 'getItem')
    .mockImplementation(() => {
      throw new Error('blocked');
    });
  setup('/careers/suretek/jobs/job-1');
  expect(
    await screen.findByRole('button', { name: 'Submit application' }),
  ).toBeVisible();
  blocked.mockRestore();
});

it('explains when a job no longer takes applications', async () => {
  setup('/careers/suretek/jobs/job-closed');
  expect(
    await screen.findByRole('heading', {
      name: 'This job isn’t taking applications',
    }),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: 'See all open jobs' })).toBeVisible();
});

it('normalizes phone numbers and describes experience', () => {
  expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
  expect(normalizePhone('0091 (98765) 43210')).toBe('+919876543210');
  expect(normalizePhone('98765 43210')).toBeNull();
  expect(formatExperience(0)).toBe('Fresher');
  expect(formatExperience(54)).toBe('4 yrs 6 mo');
  expect(formatExperience(12)).toBe('1 yr');
});

it('keeps loading the job when the console checks the sign-in session', async () => {
  // The console clears its own cache after the session check; that must not
  // cancel the public page's request.
  const { AuthProvider } = await import('./auth');
  let release: () => void = () => {};
  const jobReady = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/session'))
        return Response.json({}, { status: 401 });
      await jobReady;
      return Response.json(job);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/careers/suretek/jobs/job-1']}>
          <Routes>
            <Route path="/careers/:slug/jobs/:id" element={<ApplyPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  expect(
    await screen.findByRole('heading', { name: 'Full Stack Developer' }),
  ).toBeVisible();
});

it('still shows the job when the server leaves out the page details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        id: job.id,
        title: job.title,
        description: job.description,
        department: job.department,
        location: job.location,
        employment_type: job.employment_type,
        openings: job.openings,
        created_at: job.created_at,
        noticeVersion: job.noticeVersion,
      }),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/careers/suretek/jobs/job-1']}>
      <Routes>
        <Route path="/careers/:slug/jobs/:id" element={<ApplyPage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole('heading', { name: 'Full Stack Developer' }),
  ).toBeVisible();
  expect(screen.getByText(/PDF or Word \(\.docx\), up to 5 MB/)).toBeVisible();
  expect(
    screen.getByText(/The company may call you about this application/),
  ).toBeInTheDocument();
});
