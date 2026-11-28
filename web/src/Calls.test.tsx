import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CallPanel, JobCallsBar } from './Calls';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => vi.unstubAllGlobals());

const answer = (overrides: Record<string, unknown> = {}) => ({
  question_id: 'q1',
  question: 'Are you open to working from our Noida office?',
  answered: true,
  answer: 'Prefers to work remotely.',
  value: 'no',
  expected_answer: 'yes',
  matches_expected: false,
  ...overrides,
});

const completed = {
  id: 'call-1',
  status: 'COMPLETED',
  outcome: 'COMPLETED',
  failure_message: null,
  language: 'EN',
  recording: true,
  transcription: true,
  question_count: 2,
  attempts: 2,
  max_attempts: 3,
  scheduled: true,
  next_attempt_at: '2026-11-25T10:00:00Z',
  created_at: '2026-11-25T09:00:00Z',
  completed_at: '2026-11-25T10:05:00Z',
  requested_by_name: 'Riya Recruiter',
  attempt_history: [
    {
      id: 'attempt-1',
      number: 1,
      status: 'NO_ANSWER',
      voice_label: null,
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
      outcome: null,
      answers: [],
      summary: null,
      callback_note: null,
      transcript: null,
      has_recording: false,
      failure_message: null,
      created_at: '2026-11-25T09:00:00Z',
    },
    {
      id: 'attempt-2',
      number: 2,
      status: 'COMPLETED',
      voice_label: 'Gemini Live',
      answered_at: '2026-11-25T10:00:00Z',
      ended_at: '2026-11-25T10:04:00Z',
      duration_seconds: 240,
      outcome: 'COMPLETED',
      answers: [answer()],
      summary: 'Answered one question; prefers remote work.',
      callback_note: null,
      transcript: [
        { speaker: 'ai', text: 'Hello, is this Priya?', at: 0 },
        { speaker: 'candidate', text: 'Yes, speaking.', at: 2000 },
      ],
      has_recording: true,
      failure_message: null,
      created_at: '2026-11-25T10:00:00Z',
    },
  ],
};

function setup(
  view: Record<string, unknown>,
  options: { enabled?: boolean } = {},
) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url === '/api/v1/jobs/call-questions/settings')
        return Response.json({
          enabled: options.enabled ?? true,
          ai_available: true,
        });
      if (url === '/api/v1/applications/app-1/calls')
        return Response.json(view);
      if (url === '/api/v1/call-requests' && init.method === 'POST')
        return Response.json(
          {
            id: 'call-2',
            status: 'PLANNED',
            next_attempt_at: new Date().toISOString(),
          },
          { status: 201 },
        );
      if (url.endsWith('/recording'))
        return new Response(new Blob(['RIFF']), {
          headers: { 'Content-Type': 'audio/wav' },
        });
      if (url.endsWith('/assessment') && init.method === 'POST')
        return Response.json({ assessment_status: 'PENDING' }, { status: 201 });
      if (url === '/api/v1/jobs/job-1/calls')
        return Response.json(
          {
            planned: 3,
            already_called: 1,
            no_consent: 2,
            other: 0,
            problem: null,
          },
          { status: 201 },
        );
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const renderWith = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

it('calls a candidate with only the extras they agreed to', async () => {
  const fetcher = setup({
    can_call: true,
    blocked: null,
    consents: { call: true, recording: false, transcription: true },
    calls: [],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  const record = await screen.findByRole('checkbox', {
    name: 'Record the call (the candidate didn’t agree)',
  });
  expect(record).toBeDisabled();
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Keep a transcript' }),
  );
  await userEvent.selectOptions(screen.getByLabelText('Language'), 'HI');
  await userEvent.click(screen.getByRole('button', { name: 'Call with AI' }));
  expect(
    await screen.findByText(
      'The AI is calling the candidate now. Answers appear here after the call.',
    ),
  ).toBeVisible();
  const [, init] = fetcher.mock.calls.find(
    ([url]) => String(url) === '/api/v1/call-requests',
  )!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    applicationId: 'app-1',
    language: 'HI',
    recording: false,
    transcription: true,
    idempotencyKey: expect.any(String),
  });
});

it('shows a finished call’s answers, transcript and recording', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:recording');
  URL.revokeObjectURL = vi.fn();
  setup({
    can_call: false,
    blocked:
      'Shortlist the application (or move it to interview) to call the candidate.',
    consents: { call: true, recording: true, transcription: true },
    calls: [completed],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  expect(
    await screen.findByText(
      'Shortlist the application (or move it to interview) to call the candidate.',
    ),
  ).toBeVisible();
  expect(screen.getByText('Completed')).toBeVisible();
  expect(screen.getByText('Questions answered')).toBeVisible();
  expect(
    screen.getByText('Answered one question; prefers remote work.'),
  ).toBeVisible();
  expect(screen.getByText('Prefers to work remotely.')).toBeVisible();
  expect(screen.getByText('Expected “yes”')).toBeVisible();
  expect(screen.getByText(/1 of 2 questions answered/)).toBeVisible();
  const attempts = screen.getByRole('list', { name: 'Attempts' });
  expect(within(attempts).getByText(/Attempt 1: No answer/)).toBeVisible();
  await userEvent.click(screen.getByText('Transcript'));
  expect(screen.getByText('Yes, speaking.')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Play recording' }));
  await waitFor(() =>
    expect(document.querySelector('audio')).toHaveAttribute(
      'src',
      'blob:recording',
    ),
  );
});

it('shows the AI’s assessment as a suggestion, and can run it again', async () => {
  const attempt = completed.attempt_history[1];
  const assessed = {
    ...completed,
    attempt_history: [
      {
        ...attempt,
        answers: [
          answer({
            question_id: 'q2',
            question: 'What does a service provider do in Laravel?',
            answer: 'It registers bindings and boots services.',
            value: null,
            expected_answer: null,
            matches_expected: null,
          }),
        ],
        assessment_status: 'COMPLETED',
        assessment_failure: null,
        assessment: {
          score: 72,
          fit: 'GOOD',
          deal_breaker: false,
          answers: [
            {
              question_id: 'q2',
              rating: 'GOOD',
              reason: 'Covers bindings; misses when boot() runs.',
            },
          ],
          summary: 'Solid Laravel basics.',
          strengths: ['Knows the container'],
          concerns: ['Provider lifecycle'],
          provider_label: 'Google AI Studio',
        },
      },
    ],
  };
  const fetcher = setup({
    can_call: false,
    blocked: null,
    consents: { call: true, recording: false, transcription: false },
    calls: [assessed],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  expect(await screen.findByText('72 · Good')).toBeVisible();
  expect(screen.getByText('Solid Laravel basics.')).toBeVisible();
  expect(screen.getByText('Knows the container')).toBeVisible();
  expect(screen.getByText('Good answer')).toBeVisible();
  expect(
    screen.getByText(/Covers bindings; misses when boot\(\) runs\./),
  ).toBeVisible();
  expect(
    screen.getByText(/You decide: shortlist, move to interview/),
  ).toBeVisible();
  expect(fetcher).toHaveBeenCalled();
});

it('says when the assessment failed and runs it again', async () => {
  const attempt = completed.attempt_history[1];
  const fetcher = setup({
    can_call: false,
    blocked: null,
    consents: { call: true, recording: false, transcription: false },
    calls: [
      {
        ...completed,
        attempt_history: [
          {
            ...attempt,
            assessment_status: 'FAILED',
            assessment: null,
            assessment_failure:
              'The screening AI provider has run out of credits or hit its limit.',
          },
        ],
      },
    ],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  expect(
    await screen.findByText(/run out of credits or hit its limit/),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Assess again' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          String(url) ===
            '/api/v1/call-requests/call-1/attempts/attempt-2/assessment' &&
          init?.method === 'POST',
      ),
    ).toBe(true),
  );
});

it('stays hidden while AI calling is off and there are no calls', async () => {
  const fetcher = setup(
    {
      can_call: false,
      blocked: 'AI calling is off.',
      consents: { call: false, recording: false, transcription: false },
      calls: [],
    },
    { enabled: false },
  );
  const { container } = renderWith(<CallPanel applicationId="app-1" />);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes('call-questions/settings'),
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

it('calls a job’s shortlisted candidates and reports who was skipped', async () => {
  const fetcher = setup({});
  renderWith(<JobCallsBar jobId="job-1" />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Call shortlisted' }),
  );
  expect(
    await screen.findByText(
      'Calling 3 shortlisted candidates during calling hours. 1 already called. 2 haven’t agreed to be called.',
    ),
  ).toBeVisible();
  const [, init] = fetcher.mock.calls.find(
    ([url]) => String(url) === '/api/v1/jobs/job-1/calls',
  )!;
  expect(JSON.parse(String(init?.body))).toEqual({
    language: 'EN',
    recording: true,
    transcription: true,
  });
});

it('says when the AI will call back, as the candidate asked', async () => {
  const later = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  setup({
    can_call: false,
    blocked: 'A call is already scheduled or in progress.',
    consents: { call: true, recording: true, transcription: true },
    calls: [
      {
        ...completed,
        status: 'PLANNED',
        outcome: null,
        attempts: 1,
        next_attempt_at: later,
        completed_at: null,
        attempt_history: [
          {
            ...completed.attempt_history[1],
            number: 1,
            outcome: 'CALL_BACK',
            answers: [],
            summary: 'Busy now; asked for a call at 2 PM.',
            callback_note: 'at 2 pm',
          },
        ],
      },
    ],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  expect(
    await screen.findByText(/^Calling back .+, as the candidate asked$/),
  ).toBeVisible();
});

it('shows the interview a booking call booked', async () => {
  setup({
    can_call: false,
    blocked: null,
    consents: { call: true, recording: true, transcription: true },
    calls: [
      {
        ...completed,
        purpose: 'SCHEDULING',
        automatic: true,
        requested_by_name: null,
        attempt_history: [
          {
            ...completed.attempt_history[1],
            answers: [],
            assessment_status: null,
            assessment: null,
            summary: 'Booked the final round for Wednesday at 10 AM.',
            offered_slots: ['Wednesday 2 December at 10:00 AM'],
            booked_interview: {
              starts_at: '2026-12-02T04:30:00Z',
              mode: 'VIDEO',
              meeting_url: 'https://meet.google.com/abc-defg-hij',
              location: null,
              status: 'SCHEDULED',
            },
          },
        ],
      },
    ],
  });
  renderWith(<CallPanel applicationId="app-1" />);
  expect(
    await screen.findByText(
      /Interview booking call · English · asked .+ automatically/,
    ),
  ).toBeVisible();
  expect(screen.getByText('Interview booked:')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Meeting link' })).toHaveAttribute(
    'href',
    'https://meet.google.com/abc-defg-hij',
  );
});
