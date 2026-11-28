import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerHome } from './ManagerHome';

vi.mock('./auth', () => ({
  useAuth: () => ({
    status: 'ready',
    session: {
      user: { role: 'HIRING_MANAGER', id: 'u-hm', full_name: 'Meera Manager' },
    },
  }),
}));

const hour = 3_600_000;
const interview = (id: string, startsIn: number, mine: boolean) => ({
  id,
  application_id: `app-${id}`,
  job_id: 'job-1',
  job_title: 'PHP Developer',
  candidate_name: id === 'past' ? 'Priya Singh' : 'Rahul Sharma',
  round: 'Round 1',
  mode: 'VIDEO',
  starts_at: new Date(Date.now() + startsIn).toISOString(),
  ends_at: new Date(Date.now() + startsIn + hour).toISOString(),
  meeting_url: 'https://meet.google.com/abc-defg-hij',
  status: 'SCHEDULED',
  my_scorecard: mine,
});
let jobs: unknown[];
beforeEach(() => {
  jobs = [
    {
      id: 'job-1',
      title: 'PHP Developer',
      department: 'Engineering',
      location: 'Noida',
      status: 'PUBLISHED',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/jobs?'))
        return Response.json({ data: jobs, total: jobs.length });
      if (url.startsWith('/api/v1/applications?stage=APPLIED'))
        return Response.json({
          data: [
            {
              id: 'app-9',
              candidate_name: 'Neha Verma',
              job_title: 'PHP Developer',
              created_at: '2026-11-25T09:00:00Z',
              screening_score: 84,
            },
          ],
          total: 1,
          stage_counts: { APPLIED: 1, SHORTLISTED: 3 },
        });
      if (url.startsWith('/api/v1/applications?jobId=job-1'))
        return Response.json({
          data: [],
          total: 6,
          stage_counts: { APPLIED: 1, SHORTLISTED: 3, INTERVIEW: 2 },
        });
      if (url.startsWith('/api/v1/interviews?when=upcoming'))
        return Response.json({
          data: [interview('next', 24 * hour, false)],
          total: 1,
        });
      if (url.startsWith('/api/v1/interviews?when=past'))
        return Response.json({
          data: [
            interview('past', -24 * hour, false),
            interview('done', -48 * hour, true),
          ],
          total: 2,
        });
      return Response.json({}, { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderHome() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ManagerHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('shows a hiring manager what needs them: applicants, interviews, feedback', async () => {
  renderHome();
  expect(screen.getByRole('heading', { name: 'Welcome, Meera' })).toBeVisible();
  const review = (
    await screen.findByRole('heading', { name: 'Applicants to review' })
  ).parentElement!;
  expect(
    await within(review).findByRole('link', { name: 'Neha Verma' }),
  ).toHaveAttribute('href', '/applications?application=app-9');
  expect(within(review).getByText('84%')).toBeVisible();

  const feedback = screen.getByRole('heading', {
    name: 'Feedback due',
  }).parentElement!;
  // Only the interview without their feedback.
  expect(
    await within(feedback).findByRole('link', { name: 'Give feedback' }),
  ).toHaveAttribute('href', '/interviews?interview=past');
  expect(within(feedback).queryByText(/Rahul Sharma/)).toBeNull();

  const upcoming = screen.getByRole('heading', {
    name: 'Your upcoming interviews',
  }).parentElement!;
  expect(
    await within(upcoming).findByRole('link', { name: 'Join' }),
  ).toBeVisible();

  const yours = screen.getByRole('heading', {
    name: 'Your jobs',
  }).parentElement!;
  expect(await within(yours).findByText('2 interviewing')).toBeVisible();
  expect(
    within(yours).getByRole('link', { name: 'PHP Developer' }),
  ).toHaveAttribute('href', '/applications?job=job-1');
  expect(screen.getByText('Shortlisted').previousSibling).toHaveTextContent(
    '3',
  );
});

it('explains how jobs appear when there are none yet', async () => {
  jobs = [];
  renderHome();
  expect(
    await screen.findByText(/Request a job, and follow it here/),
  ).toBeVisible();
});
