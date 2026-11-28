import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ApplicationInterviews,
  InterviewCalendarSetting,
  InterviewForm,
  InterviewsPage,
} from './Interviews';

vi.setConfig({ testTimeout: 20000 });

let role = 'RECRUITER';
vi.mock('./auth', () => ({
  useAuth: () => ({
    status: 'ready',
    session: { user: { role, id: 'user-1' } },
  }),
}));

// Wednesday 18 November 2026, 9 AM where the tests run.
const NOW = new Date(2026, 10, 18, 9, 0);
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

const panel = [
  { id: 'user-1', full_name: 'Riya Recruiter', role: 'RECRUITER' },
  { id: 'user-2', full_name: 'Arjun Rao', role: 'INTERVIEWER' },
];
const upcoming = {
  id: 'iv-1',
  application_id: 'app-1',
  job_id: 'job-1',
  job_title: 'Senior PHP Developer',
  candidate_name: 'Rahul Sharma',
  application_stage: 'INTERVIEW',
  round: 'Round 1',
  mode: 'VIDEO',
  starts_at: at(19, 10),
  ends_at: at(19, 10, 45),
  location: null as string | null,
  meeting_url: 'https://meet.google.com/abc-defg-hij' as string | null,
  status: 'SCHEDULED',
  criteria_snapshot: [] as { id: string; label: string }[],
  panelist_ids: ['user-1', 'user-2'],
  panel,
  scorecard_count: 0,
  my_scorecard: false,
  on_calendar: true,
  calendar_provider: 'google_calendar' as string | null,
  created_by: 'user-1',
  created_by_name: 'Riya Recruiter',
};
const past = {
  ...upcoming,
  id: 'iv-2',
  application_id: 'app-2',
  candidate_name: 'Priya Singh',
  round: 'Technical round',
  mode: 'ONSITE',
  starts_at: at(17, 15),
  ends_at: at(17, 16),
  location: 'Noida office, room 4',
  meeting_url: null,
  criteria_snapshot: [{ id: 'php', label: 'PHP and Laravel' }],
  panelist_ids: ['user-1'],
  panel: [panel[0]],
  on_calendar: false,
  calendar_provider: null,
};

let provider: string | null;
/** Connected calendars; just `provider` unless a test says otherwise. */
let connected: string[] | null;
/** What the calendar did, as the API reports it. */
const sent = (status: string, extra: object = {}) => ({
  status,
  provider: 'google_calendar',
  organizer: 'recruiting@example.test',
  candidate: 'rahul@example.com',
  panel: 2,
  warnings: [],
  ...extra,
});
let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  role = 'RECRUITER';
  provider = 'google_calendar';
  connected = null;
  calls = [];
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
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
      const scoped = role === 'INTERVIEWER';
      const view = (item: typeof upcoming) =>
        scoped ? { ...item, scorecard_count: null } : item;
      if (url === '/api/v1/interviews/calendar')
        return method === 'PUT'
          ? json({ provider: (body as { provider: string }).provider })
          : json({
              provider,
              connected: connected ?? (provider ? [provider] : []),
            });
      if (url === '/api/v1/interviews/panelists') return json({ data: panel });
      if (url.startsWith('/api/v1/interviews?from='))
        return json({ data: [view(upcoming), view(past)], total: 2 });
      if (url.startsWith('/api/v1/interviews?when=past'))
        return json({ data: [view(past)], total: 1 });
      if (url.startsWith('/api/v1/interviews?when=upcoming'))
        return json({ data: [view(upcoming)], total: 1 });
      if (url.startsWith('/api/v1/interviews?applicationId=app-1'))
        return json({ data: [view(upcoming)], total: 1 });
      if (url === '/api/v1/interviews' && method === 'POST')
        return json(
          {
            ...upcoming,
            id: 'iv-new',
            calendar: sent('added', {
              provider: (body as { calendarProvider?: string })
                .calendarProvider,
            }),
          },
          201,
        );
      if (url === '/api/v1/interviews/iv-1' && method === 'PATCH')
        return json({
          ...upcoming,
          calendar: sent('updated'),
        });
      if (url === '/api/v1/interviews/iv-1/calendar')
        return json({
          ...upcoming,
          calendar_provider: 'microsoft_calendar',
          calendar: sent('moved', {
            provider: 'microsoft_calendar',
            organizer: 'hr@contoso.test',
          }),
        });
      if (url === '/api/v1/interviews/iv-1') return json(view(upcoming));
      if (url === '/api/v1/interviews/iv-2') return json(view(past));
      if (url.endsWith('/cancel')) return json({ ...upcoming });
      if (url.endsWith('/scorecards') && method === 'POST')
        return json({ id: 'card-1' }, 201);
      if (url.endsWith('/scorecards')) return json([]);
      if (url.endsWith('/stage')) return json({});
      return json({});
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

it('shows the month’s interviews in a calendar, and a day’s agenda', async () => {
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  expect(
    await screen.findByText(/Interviews go in your connected Google Calendar/),
  ).toBeVisible();
  expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
  // The weeks shown: Monday 26 October to Sunday 6 December.
  const range = new URLSearchParams(
    calls
      .find((c) => c.url.startsWith('/api/v1/interviews?from='))!
      .url.split('?')[1],
  );
  expect(range.get('from')).toBe(new Date(2026, 9, 26).toISOString());
  expect(range.get('to')).toBe(new Date(2026, 11, 7).toISOString());
  expect(
    await screen.findByRole('button', { name: /Rahul Sharma/ }),
  ).toBeVisible();
  expect(screen.getByText('No interviews on this day.')).toBeVisible();

  await user.click(
    screen.getByRole('button', { name: 'Thursday, November 19: 1 interview' }),
  );
  const agenda = screen.getByRole('heading', {
    name: 'Thursday, November 19',
  }).parentElement!;
  expect(
    within(agenda).getByRole('button', { name: /Round 1 with Rahul Sharma/ }),
  ).toBeVisible();
  expect(within(agenda).getByRole('link', { name: 'Join' })).toHaveAttribute(
    'href',
    'https://meet.google.com/abc-defg-hij',
  );
  expect(within(agenda).getByText('In Google Calendar')).toBeVisible();
});

it('opens an interview: when, how, who, the calendar and feedback', async () => {
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  await user.click(await screen.findByRole('button', { name: /Rahul Sharma/ }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Round 1: Rahul Sharma',
  });
  expect(within(dialog).getByText('Upcoming')).toBeVisible();
  expect(
    within(dialog).getByRole('link', {
      name: 'https://meet.google.com/abc-defg-hij',
    }),
  ).toBeVisible();
  expect(within(dialog).getByText('Arjun Rao')).toBeVisible();
  expect(
    within(dialog).getByText(
      /In Google Calendar\. The panel and the candidate were invited/,
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      'The panel gives feedback once the interview has started.',
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByRole('button', { name: 'Reschedule' }),
  ).toBeVisible();
  // Feedback waits for the interview.
  expect(
    within(dialog).queryByRole('button', { name: 'Give feedback' }),
  ).toBeNull();
});

it('cancels an interview with a reason, and the calendar tells everyone', async () => {
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  await user.click(await screen.findByRole('button', { name: /Rahul Sharma/ }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Cancel interview',
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Cancel interview',
  });
  await user.type(
    within(dialog).getByLabelText('Reason'),
    'The candidate took another offer',
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Cancel interview' }),
  );
  expect(
    await screen.findByText(
      'Interview cancelled. Google Calendar told everyone invited.',
    ),
  ).toBeVisible();
  expect(calls.find((c) => c.url.endsWith('/iv-1/cancel'))?.body).toEqual({
    reason: 'The candidate took another offer',
  });
});

it('reschedules, keeping the link, and the calendar event follows', async () => {
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  await user.click(await screen.findByRole('button', { name: /Rahul Sharma/ }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Reschedule',
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Reschedule interview',
  });
  expect(within(dialog).getByLabelText('Round')).toHaveValue('Round 1');
  expect(
    within(dialog).getByText(
      /The Google Calendar event changes too, and everyone invited is told/,
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByRole('radio', { name: 'Use my own link' }),
  ).toBeChecked();
  const time = within(dialog).getByLabelText('Start time');
  await user.clear(time);
  await user.type(time, '11:30');
  await user.click(
    within(dialog).getByRole('button', { name: 'Save changes' }),
  );
  expect(
    await screen.findByText(
      /Google Calendar sent the change from recruiting@example\.test to rahul@example\.com and 2 panel members\./,
    ),
  ).toBeVisible();
  const patch = calls.find((c) => c.method === 'PATCH')!;
  expect(patch.url).toBe('/api/v1/interviews/iv-1');
  expect(patch.body).toMatchObject({
    round: 'Round 1',
    mode: 'VIDEO',
    startsAt: at(19, 11, 30),
    endsAt: at(19, 12, 15),
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    panelistIds: ['user-1', 'user-2'],
  });
  expect(patch.body).not.toHaveProperty('sendInvitations');
});

it('lets a panelist give feedback on a past interview, from the list', async () => {
  role = 'INTERVIEWER';
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  await user.click(await screen.findByRole('tab', { name: /List/ }));
  await user.click(await screen.findByRole('tab', { name: 'Past' }));
  const row = (await screen.findByText('Priya Singh')).closest('tr')!;
  expect(within(row).getByText('Your feedback is due')).toBeVisible();
  expect(within(row).getByText('Not in a calendar')).toBeVisible();
  await user.click(within(row).getByRole('button'));
  const details = await screen.findByRole('dialog', {
    name: 'Technical round: Priya Singh',
  });
  expect(within(details).getByText('Noida office, room 4')).toBeVisible();
  // Only recruiters reschedule or cancel.
  expect(
    within(details).queryByRole('button', { name: 'Reschedule' }),
  ).toBeNull();
  await user.click(
    within(details).getByRole('button', { name: 'Give feedback' }),
  );
  const form = await screen.findByRole('dialog', {
    name: 'Interview feedback',
  });
  await user.click(
    within(form).getByRole('button', { name: 'Submit feedback' }),
  );
  expect(within(form).getByRole('alert')).toHaveTextContent(
    'Score every criterion.',
  );
  await user.selectOptions(within(form).getByLabelText('PHP and Laravel'), '4');
  await user.click(within(form).getByRole('radio', { name: 'Hire' }));
  await user.type(
    within(form).getByLabelText('Notes'),
    'Solid Laravel answers.',
  );
  await user.click(
    within(form).getByRole('button', { name: 'Submit feedback' }),
  );
  expect(
    await screen.findByText('Feedback for Priya Singh submitted.'),
  ).toBeVisible();
  expect(
    calls.find((c) => c.method === 'POST' && c.url.endsWith('/scorecards'))
      ?.body,
  ).toEqual({
    scores: [{ criterionId: 'php', score: 4 }],
    recommendation: 'HIRE',
    notes: 'Solid Laravel answers.',
  });
  // Panelists don't see whether a calendar is connected.
  expect(calls.some((c) => c.url === '/api/v1/interviews/calendar')).toBe(
    false,
  );
});

it('schedules with a calendar invitation that creates the Meet link', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  renderWith(
    <InterviewForm
      application={{
        id: 'app-1',
        candidateName: 'Rahul Sharma',
        jobTitle: 'Senior PHP Developer',
        stage: 'SHORTLISTED',
      }}
      onClose={() => undefined}
      onSaved={saved}
    />,
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Schedule interview',
  });
  expect(
    await within(dialog).findByRole('checkbox', {
      name: /Add to Google Calendar and invite the panel and the candidate/,
    }),
  ).toBeChecked();
  expect(
    within(dialog).getByRole('radio', { name: 'Create a Google Meet link' }),
  ).toBeChecked();
  expect(within(dialog).queryByLabelText('Your meeting link')).toBeNull();
  await within(dialog).findByRole('checkbox', { name: /Riya Recruiter/ });
  await user.click(
    within(dialog).getByRole('button', { name: 'Schedule interview' }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(saved.mock.calls[0][0]).toMatch(
    /Interview scheduled for Rahul Sharma .* and moved them to In Interview\. Google Calendar sent invitations from recruiting@example\.test to rahul@example\.com and 2 panel members\./,
  );
  const created = calls.find(
    (c) => c.url === '/api/v1/interviews' && c.method === 'POST',
  )!.body as Record<string, unknown>;
  expect(created).toMatchObject({
    applicationId: 'app-1',
    mode: 'VIDEO',
    panelistIds: ['user-1'],
    sendInvitations: true,
  });
  expect(created).not.toHaveProperty('meetingUrl');
  expect(calls.find((c) => c.url.endsWith('/app-1/stage'))?.body).toEqual({
    stage: 'INTERVIEW',
  });
});

it('without a calendar, says interviews stay in HireAI and asks for a link', async () => {
  provider = null;
  renderWith(<InterviewsPage />);
  expect(await screen.findByText(/No calendar is connected/)).toBeVisible();
  expect(
    screen.getByText(/An HR Admin can connect Google Calendar/),
  ).toBeVisible();
});

it('shows an application’s interviews, and opens one', async () => {
  const user = userEvent.setup();
  renderWith(<ApplicationInterviews applicationId="app-1" />);
  const card = await screen.findByRole('button', {
    name: /Round 1 with Rahul Sharma/,
  });
  expect(screen.getByText(/Riya Recruiter, Arjun Rao/)).toBeVisible();
  await user.click(card);
  expect(
    await screen.findByRole('dialog', { name: 'Round 1: Rahul Sharma' }),
  ).toBeVisible();
});

it('with both calendars connected, schedules in the one chosen, and says what stops an email', async () => {
  connected = ['google_calendar', 'microsoft_calendar'];
  const user = userEvent.setup();
  const saved = vi.fn();
  renderWith(
    <InterviewForm
      application={{
        id: 'app-1',
        candidateName: 'Rahul Sharma',
        jobTitle: 'Senior PHP Developer',
        stage: 'INTERVIEW',
      }}
      onClose={() => undefined}
      onSaved={saved}
    />,
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Schedule interview',
  });
  const calendar = await within(dialog).findByLabelText('Calendar');
  expect(calendar).toHaveValue('google_calendar');
  await user.selectOptions(calendar, 'microsoft_calendar');
  expect(
    within(dialog).getByRole('radio', {
      name: 'Create a Microsoft Teams link',
    }),
  ).toBeChecked();
  await within(dialog).findByRole('checkbox', { name: /Riya Recruiter/ });
  await user.click(
    within(dialog).getByRole('button', { name: 'Schedule interview' }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(
    calls.find((c) => c.url === '/api/v1/interviews' && c.method === 'POST')
      ?.body,
  ).toMatchObject({
    sendInvitations: true,
    calendarProvider: 'microsoft_calendar',
  });
  expect(saved.mock.calls[0][0]).toMatch(
    /Microsoft Calendar sent invitations from recruiting@example\.test to rahul@example\.com/,
  );
});

it('says when the candidate’s address is the calendar’s own account', async () => {
  const user = userEvent.setup();
  const saved = vi.fn();
  renderWith(
    <InterviewForm
      application={{
        id: 'app-1',
        candidateName: 'Rahul Sharma',
        jobTitle: 'Senior PHP Developer',
        stage: 'INTERVIEW',
      }}
      onClose={() => undefined}
      onSaved={saved}
    />,
  );
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('checkbox', { name: /Riya Recruiter/ });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input) === '/api/v1/interviews' && init?.method === 'POST'
      ? Response.json(
          {
            ...upcoming,
            calendar: sent('added', {
              organizer: 'rahul@example.com',
              warnings: ['candidate_is_organizer'],
            }),
          },
          { status: 201 },
        )
      : original(input, init),
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Schedule interview' }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(saved.mock.calls[0][1]).toBe(
    'rahul@example.com is Google Calendar’s own account, so the event is in that calendar but no invitation email was sent to it. Use a different address for the candidate, or connect a shared recruiting calendar.',
  );
});

it('moves an interview to the other connected calendar', async () => {
  connected = ['google_calendar', 'microsoft_calendar'];
  const user = userEvent.setup();
  renderWith(<InterviewsPage />);
  await user.click(await screen.findByRole('button', { name: /Rahul Sharma/ }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Round 1: Rahul Sharma',
  });
  expect(
    within(dialog).getByRole('button', { name: 'Send the invitation again' }),
  ).toBeVisible();
  await user.click(
    await within(dialog).findByRole('button', {
      name: 'Move to Microsoft Calendar',
    }),
  );
  expect(
    await within(dialog).findByText(
      /Moved to Microsoft Calendar: the old event was cancelled, and Microsoft Calendar sent new invitations from hr@contoso\.test to rahul@example\.com and 2 panel members\./,
    ),
  ).toBeVisible();
  expect(
    calls.find((c) => c.url === '/api/v1/interviews/iv-1/calendar')?.body,
  ).toEqual({ calendarProvider: 'microsoft_calendar' });
});

it('lets an HR Admin choose the calendar interviews go in', async () => {
  connected = ['google_calendar', 'microsoft_calendar'];
  const user = userEvent.setup();
  renderWith(<InterviewCalendarSetting version="v1" />);
  const group = await screen.findByRole('group', { name: 'Interviews go in' });
  expect(
    within(group).getByRole('radio', { name: 'Google Calendar' }),
  ).toBeChecked();
  await user.click(
    within(group).getByRole('radio', { name: 'Microsoft Calendar' }),
  );
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      provider: 'microsoft_calendar',
    }),
  );
});
