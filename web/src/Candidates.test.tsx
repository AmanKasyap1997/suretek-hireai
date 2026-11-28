import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CandidatesPage } from './Candidates';

vi.setConfig({ testTimeout: 20000 });

vi.mock('./auth', () => ({
  useAuth: () => ({
    status: 'ready',
    session: { user: { role: 'RECRUITER', id: 'user-1' } },
  }),
}));

const row = (
  id: string,
  name: string,
  stage: string,
  score: number | null,
  fit: string | null,
) => ({
  id,
  job_id: 'job-1',
  candidate_id: `cand-${id}`,
  stage,
  created_at: '2026-10-14T09:00:00Z',
  job_title: 'Senior PHP Developer',
  candidate_name: name,
  candidate_email: `${name.split(' ')[0].toLowerCase()}@example.com`,
  current_title: 'PHP Developer',
  total_experience_months: 60,
  screening_status: score === null ? null : 'COMPLETED',
  screening_score: score,
  screening_fit: fit,
  call_status: null as string | null,
  call_outcome: null as string | null,
  call_completed: false,
  call_assessment_status: null as string | null,
  call_score: null as number | null,
  call_fit: null as string | null,
});
const rows = [
  // Completed the AI call: interviews may go ahead.
  {
    ...row('app-1', 'Rahul Sharma', 'SHORTLISTED', 92, 'STRONG'),
    call_status: 'COMPLETED',
    call_outcome: 'COMPLETED',
    call_completed: true,
    call_assessment_status: 'COMPLETED',
    call_score: 78,
    call_fit: 'GOOD',
  },
  row('app-2', 'Priya Singh', 'SHORTLISTED', 64, 'GOOD'),
  {
    ...row('app-3', 'Amit Kumar', 'INTERVIEW', null, null),
    call_status: 'PLANNED',
  },
  // Busy on the first call: the AI calls back when they asked.
  {
    ...row('app-4', 'Neha Dubey', 'SHORTLISTED', 70, 'GOOD'),
    call_status: 'PLANNED',
    call_back: true,
    call_next_at: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
  },
];
/** Whether the organization has AI calling on. */
let callingOn = true;
const details = {
  id: 'app-1',
  stage: 'SHORTLISTED',
  created_at: '2026-10-14T09:00:00Z',
  job: { id: 'job-1', title: 'Senior PHP Developer' },
  candidate: {
    id: 'cand-app-1',
    full_name: 'Rahul Sharma',
    erased: false,
    email: 'rahul@example.com',
    phone: '+919876543210',
  },
  details: {
    current_location: 'Delhi-NCR',
    willing_to_relocate: true,
    total_experience_months: 60,
    current_company: 'Acme',
    current_title: 'PHP Developer',
    notice_period: 'DAYS_30',
    last_working_day: null,
    current_ctc: 1200000,
    expected_ctc: 1600000,
    ctc_currency: 'INR',
    linkedin_url: null,
    portfolio_url: null,
    cover_letter: null,
    source: 'LINKEDIN',
    referrer: null,
  },
  documents: [],
  pay_and_contact_hidden: false,
};
const screening = {
  screening: {
    id: 'scr-1',
    status: 'COMPLETED',
    trigger: 'AUTOMATIC',
    score: 92,
    fit: 'STRONG',
    missing_must_have: false,
    provider_label: 'Google AI Studio',
    model: 'gemini',
    failure_message: null,
    created_at: '2026-10-14T09:00:00Z',
    completed_at: '2026-10-14T09:01:00Z',
    outdated: false,
    result: {
      criteria: [],
      derived_criteria: false,
      summary: 'Five years of PHP.',
      strengths: ['Relevant experience (5 years)'],
      concerns: ['Little cloud work'],
      questions: [],
      skills: ['PHP', 'Laravel', 'MySQL'],
      instructions_in_resume: false,
    },
  },
};

let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  callingOn = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ url, method, body });
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status });
      if (url.startsWith('/api/v1/applications?'))
        return json({
          data: rows,
          total: 3,
          stage_counts: { SHORTLISTED: 2, INTERVIEW: 1 },
        });
      if (url.startsWith('/api/v1/jobs?'))
        return json({
          data: [
            { id: 'job-1', title: 'Senior PHP Developer', status: 'PUBLISHED' },
          ],
        });
      if (/\/applications\/app-\d\/details$/.test(url)) return json(details);
      if (/\/applications\/app-\d\/screening$/.test(url) && method === 'GET')
        return json(screening);
      if (/\/applications\/app-\d\/stage$/.test(url)) return json({});
      if (/\/applications\/app-\d\/calls$/.test(url))
        return json({
          can_call: true,
          blocked: null,
          consents: { call: true, recording: true, transcription: true },
          calls: [],
        });
      if (url.endsWith('/jobs/call-questions/settings'))
        return json({ enabled: callingOn, ai_available: true });
      if (url.endsWith('/interviews/panelists'))
        return json({
          data: [
            { id: 'user-1', full_name: 'Riya Recruiter', role: 'RECRUITER' },
            { id: 'user-2', full_name: 'Arjun Rao', role: 'INTERVIEWER' },
          ],
        });
      if (url.endsWith('/interviews') && method === 'POST')
        return json({ id: 'int-1' }, 201);
      if (url.startsWith('/api/v1/candidates?')) return json({ data: [] });
      if (url.endsWith('/api/v1/candidates') && method === 'POST')
        return json({ id: 'cand-new' }, 201);
      if (url.endsWith('/api/v1/applications') && method === 'POST')
        return json({ id: 'app-new' }, 201);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <CandidatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const listCalls = () =>
  calls.filter((c) => c.url.startsWith('/api/v1/applications?'));

it('lists candidates from shortlisted onward, with each stage’s count', async () => {
  renderPage();
  expect(
    await screen.findByRole('tab', { name: 'All Candidates (3)' }),
  ).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Shortlisted (2)' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Offered (0)' })).toBeVisible();
  const query = new URLSearchParams(listCalls()[0].url.split('?')[1]);
  expect(query.get('stages')).toBe('SHORTLISTED,INTERVIEW,OFFER,HIRED');
  expect(query.get('counts')).toBe('true');
  expect(screen.getByText('92%')).toBeVisible();
  expect(
    screen.getByText('rahul@example.com', { selector: 'small' }),
  ).toBeVisible();

  // The first candidate's details, skills and the AI's insights.
  expect(
    await screen.findByRole('heading', { name: 'Rahul Sharma', level: 2 }),
  ).toBeVisible();
  expect(await screen.findByText('₹16,00,000')).toBeVisible();
  expect(await screen.findByText('Laravel')).toBeVisible();
  expect(screen.getByText('Strong match for the role (92%)')).toBeVisible();
  expect(screen.getByText('Little cloud work')).toBeVisible();
  expect(screen.getByText('AI suggestions only: you decide.')).toBeVisible();
});

it('filters by stage tab and by AI result', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole('tab', { name: 'In Interview (1)' }),
  );
  await waitFor(() =>
    expect(listCalls().at(-1)!.url).toContain('stage=INTERVIEW'),
  );
  await user.selectOptions(
    screen.getByLabelText('Filter by AI result'),
    'STRONG',
  );
  await waitFor(() => expect(listCalls().at(-1)!.url).toContain('fit=STRONG'));
  await user.selectOptions(
    screen.getByLabelText('Filter by AI result'),
    'not_screened',
  );
  await waitFor(() =>
    expect(listCalls().at(-1)!.url).toContain('screening=not_screened'),
  );
});

it('schedules an interview with the panel and moves the candidate on', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('heading', { name: 'Rahul Sharma', level: 2 });
  await user.click(screen.getByRole('button', { name: 'Schedule Interview' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Schedule interview',
  });
  await user.type(
    within(dialog).getByLabelText('Meeting link'),
    'https://meet.example.com/abc',
  );
  // You're on the panel by default; add an interviewer.
  expect(
    await within(dialog).findByRole('checkbox', { name: /Riya Recruiter/ }),
  ).toBeChecked();
  await user.click(within(dialog).getByRole('checkbox', { name: /Arjun Rao/ }));
  await user.click(
    within(dialog).getByRole('button', { name: 'Schedule interview' }),
  );
  expect(
    await screen.findByText(/Interview scheduled for Rahul Sharma/),
  ).toBeVisible();
  const created = calls.find(
    (c) => c.url.endsWith('/interviews') && c.method === 'POST',
  )!.body as Record<string, unknown>;
  expect(created).toMatchObject({
    applicationId: 'app-1',
    round: 'Round 1',
    mode: 'VIDEO',
    meetingUrl: 'https://meet.example.com/abc',
    panelistIds: ['user-1', 'user-2'],
  });
  expect(
    Date.parse(created.endsAt as string) -
      Date.parse(created.startsAt as string),
  ).toBe(45 * 60_000);
  expect(calls.find((c) => c.url.endsWith('/app-1/stage'))?.body).toEqual({
    stage: 'INTERVIEW',
  });
});

it('rejects ticked candidates together, with a reason', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole('checkbox', { name: 'Select Rahul Sharma' }),
  );
  await user.click(
    screen.getByRole('checkbox', { name: 'Select Priya Singh' }),
  );
  await user.click(
    screen.getByRole('button', { name: 'Bulk actions for 2 candidates' }),
  );
  await user.click(screen.getByRole('menuitem', { name: 'Reject…' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Reject 2 candidates?',
  });
  await user.selectOptions(
    within(dialog).getByLabelText('Reason'),
    'EXPERIENCE',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
  expect(await screen.findByText('Rejected 2 candidates.')).toBeVisible();
  const moves = calls.filter((c) => c.url.endsWith('/stage'));
  expect(moves.map((c) => c.url)).toEqual([
    '/api/v1/applications/app-1/stage',
    '/api/v1/applications/app-2/stage',
  ]);
  expect(moves[0].body).toEqual({
    stage: 'REJECTED',
    reasonCode: 'EXPERIENCE',
  });
});

it('adds a candidate straight onto a job’s shortlist', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole('button', { name: /Add Candidate/ }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Add candidate' });
  await user.type(within(dialog).getByLabelText('Full name'), 'Kiran Rao');
  await user.type(within(dialog).getByLabelText('Email'), 'kiran@example.com');
  await user.selectOptions(within(dialog).getByLabelText('Job'), 'job-1');
  await user.click(
    within(dialog).getByRole('button', { name: 'Add candidate' }),
  );
  expect(
    await screen.findByText('Kiran Rao was added to the shortlist.'),
  ).toBeVisible();
  expect(
    calls.find(
      (c) => c.url.endsWith('/api/v1/candidates') && c.method === 'POST',
    )?.body,
  ).toEqual({ fullName: 'Kiran Rao', email: 'kiran@example.com' });
  expect(
    calls.find(
      (c) => c.url.endsWith('/api/v1/applications') && c.method === 'POST',
    )?.body,
  ).toEqual({ jobId: 'job-1', candidateId: 'cand-new' });
  expect(calls.find((c) => c.url.endsWith('/app-new/stage'))?.body).toEqual({
    stage: 'SHORTLISTED',
  });
});

it('shows each candidate’s AI call, and waits for a completed call before interviews', async () => {
  const user = userEvent.setup();
  renderPage();
  const rahul = (
    await screen.findByRole('button', { name: 'View Rahul Sharma' })
  ).closest('tr')!;
  expect(within(rahul).getByText('Completed')).toBeVisible();
  expect(within(rahul).getByText('78%')).toBeVisible();
  const priya = screen
    .getByRole('button', { name: 'View Priya Singh' })
    .closest('tr')!;
  expect(within(priya).getByText('Not called')).toBeVisible();
  const amit = screen
    .getByRole('button', { name: 'View Amit Kumar' })
    .closest('tr')!;
  expect(within(amit).getByText('Scheduled')).toBeVisible();
  const neha = screen
    .getByRole('button', { name: 'View Neha Dubey' })
    .closest('tr')!;
  expect(within(neha).getByText('Call back')).toBeVisible();
  expect(within(neha).getByText(/^(Tomorrow|\d+ \w+), /)).toBeVisible();

  // Priya hasn't completed a call: no interview yet.
  await user.click(
    within(priya).getByRole('button', { name: 'View Priya Singh' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Priya Singh', level: 2 }),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Schedule Interview' }),
    ).toBeDisabled(),
  );
  await user.click(
    screen.getByRole('button', { name: 'Needs a completed AI call. Call now' }),
  );
  expect(screen.getByRole('tab', { name: 'Call Summary' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await user.click(
    within(priya).getByRole('button', { name: 'Actions for Priya Singh' }),
  );
  expect(
    screen.getByRole('menuitem', { name: /Move to In Interview/ }),
  ).toBeDisabled();
  expect(
    screen.getByRole('menuitem', { name: /Schedule interview/ }),
  ).toHaveTextContent('Available once the candidate completes an AI call.');

  // Ticking both: only Rahul moves on.
  await user.keyboard('{Escape}');
  await user.click(
    screen.getByRole('checkbox', { name: 'Select Rahul Sharma' }),
  );
  await user.click(
    screen.getByRole('checkbox', { name: 'Select Priya Singh' }),
  );
  await user.click(
    screen.getByRole('button', { name: 'Bulk actions for 2 candidates' }),
  );
  await user.click(
    screen.getByRole('menuitem', { name: /Move to In Interview/ }),
  );
  expect(
    await screen.findByText(
      'Moved 1 candidate to In Interview. 1 candidate without a completed AI call stayed shortlisted.',
    ),
  ).toBeVisible();
  expect(
    calls.filter((c) => c.url.endsWith('/stage')).map((c) => c.url),
  ).toEqual(['/api/v1/applications/app-1/stage']);
});

it('doesn’t wait for a call while AI calling is off', async () => {
  callingOn = false;
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole('button', { name: 'View Priya Singh' }),
  );
  await screen.findByRole('heading', { name: 'Priya Singh', level: 2 });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Schedule Interview' }),
    ).toBeEnabled(),
  );
  expect(
    screen.queryByRole('button', { name: /Needs a completed AI call/ }),
  ).toBeNull();
});
