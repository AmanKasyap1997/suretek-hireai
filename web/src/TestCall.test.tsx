import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestCallHandlers } from './testCallAudio';

const audio = vi.hoisted(() => ({
  handlers: null as TestCallHandlers | null,
  hangUp: vi.fn(),
  failure: null as Error | null,
}));
vi.mock('./testCallAudio', () => ({
  startTestCall: vi.fn(async (_ticket: string, handlers: TestCallHandlers) => {
    if (audio.failure) throw audio.failure;
    audio.handlers = handlers;
    return { hangUp: audio.hangUp };
  }),
}));

import { TestCallDialog } from './TestCall';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => {
  vi.unstubAllGlobals();
  audio.handlers = null;
  audio.failure = null;
  audio.hangUp.mockReset();
});

const questions = [
  {
    id: 'q1',
    text: 'Are you open to working from our Noida office?',
    answer_type: 'yes_no' as const,
    expected_answer: 'yes' as const,
    criterion_id: null,
  },
];

function setup() {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/v1/calls/test-sessions' && init?.method === 'POST'
      ? Response.json(
          {
            ticket: 'ticket-1',
            voice: 'Gemini Live',
            expires_in: 60,
            max_seconds: 300,
            sample_rate: 16000,
          },
          { status: 201 },
        )
      : Response.json({}, { status: 404 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TestCallDialog jobId="job-1" questions={questions} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { fetcher, onClose };
}

it('talks to the AI with the job’s draft questions and shows what it recorded', async () => {
  const { fetcher } = setup();
  await userEvent.selectOptions(screen.getByLabelText('Language'), 'HI');
  await userEvent.click(
    screen.getByRole('button', { name: 'Start test call' }),
  );
  expect(await screen.findByText('Connecting to the voice AI…')).toBeVisible();
  const [, init] = fetcher.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toEqual({
    jobId: 'job-1',
    language: 'HI',
    questions,
  });
  act(() => {
    audio.handlers!.live('google_ai');
    audio.handlers!.transcript(
      'ai',
      'Namaste! Kya abhi baat karne ka sahi samay hai?',
    );
    audio.handlers!.transcript('candidate', 'Haan, boliye.');
    audio.handlers!.answer({
      question_id: 'q1',
      question: questions[0].text,
      answered: true,
      answer: 'Yes, happy to work from Noida.',
      value: 'yes',
      expected_answer: 'yes',
      matches_expected: true,
    });
  });
  expect(screen.getByText(/On the call with Gemini Live/)).toBeVisible();
  expect(screen.getByText('Haan, boliye.')).toBeVisible();
  expect(screen.getByText('Yes, happy to work from Noida.')).toBeVisible();
  expect(screen.getByText('As expected')).toBeVisible();
  act(() => {
    audio.handlers!.ended('COMPLETED', 'Answered the question.', 'ai');
    audio.handlers!.closed();
  });
  expect(screen.getByText('The call ended.')).toBeVisible();
  expect(screen.getByText('Questions answered')).toBeVisible();
  expect(screen.getByText('Answered the question.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
});

it('hangs up when asked, and explains a blocked microphone', async () => {
  setup();
  await userEvent.click(
    screen.getByRole('button', { name: 'Start test call' }),
  );
  await screen.findByText('Connecting to the voice AI…');
  act(() => audio.handlers!.live('openai'));
  await userEvent.click(screen.getByRole('button', { name: 'Hang up' }));
  expect(audio.hangUp).toHaveBeenCalled();
  expect(screen.getByText('The call ended.')).toBeVisible();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  audio.failure = new DOMException('denied', 'NotAllowedError');
  await userEvent.click(
    screen.getByRole('button', { name: 'Start test call' }),
  );
  expect(
    await screen.findByText(
      'Allow microphone access in your browser to try a call.',
    ),
  ).toBeVisible();
});
