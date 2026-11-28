import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AutoInterviewSettings,
  AutoShortlistSettings,
  InterviewBookingDialog,
} from './HiringAutomation';

vi.setConfig({ testTimeout: 20000 });
afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Response.json(handler(url, init) ?? {});
    }),
  );
  return calls;
}
const renderWith = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

/** The settings API, keeping what's saved. */
function settingsApi(start: {
  shortlist_score: number | null;
  call_shortlisted: boolean;
  interview_score: number | null;
}) {
  let automation = start;
  return stub((url, init) => {
    if (url.endsWith('/organization/ai-settings/automation')) {
      const body = JSON.parse(String(init.body));
      automation = {
        shortlist_score: body.shortlistScore,
        call_shortlisted: body.callShortlisted,
        interview_score: body.interviewScore,
      };
    }
    return { calling_enabled: true, automation };
  });
}

it('shortlists at a resume score and calls, from the resume screening card', async () => {
  // Moving to interviews is already on: saving here keeps it.
  const calls = settingsApi({
    shortlist_score: null,
    call_shortlisted: false,
    interview_score: 80,
  });
  const user = userEvent.setup();
  renderWith(<AutoShortlistSettings />);
  const shortlist = await screen.findByRole('checkbox', {
    name: /Shortlist applicants whose resume/,
  });
  expect(shortlist).not.toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: /Then call them/ }),
  ).toBeDisabled();
  // Nothing to save until something changes.
  expect(
    screen.queryByRole('button', { name: 'Save automatic steps' }),
  ).toBeNull();
  await user.click(shortlist);
  await user.click(screen.getByRole('checkbox', { name: /Then call them/ }));
  await user.click(
    screen.getByRole('button', { name: 'Save automatic steps' }),
  );
  expect(
    await screen.findByText(
      'Saved. Applicants scoring 70 or more are shortlisted by themselves.',
    ),
  ).toBeVisible();
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    shortlistScore: 70,
    callShortlisted: true,
    interviewScore: 80,
  });
});

it('moves to interviews at a call score, from the AI calling card', async () => {
  const calls = settingsApi({
    shortlist_score: 70,
    call_shortlisted: true,
    interview_score: null,
  });
  const user = userEvent.setup();
  renderWith(<AutoInterviewSettings />);
  await user.click(
    await screen.findByRole('checkbox', {
      name: /Move candidates whose AI call/,
    }),
  );
  const min = screen.getByLabelText('Call score to move to interviews at');
  await user.clear(min);
  await user.type(min, '75');
  await user.click(
    screen.getByRole('button', { name: 'Save automatic steps' }),
  );
  expect(
    await screen.findByText(
      'Saved. Candidates whose call scores 75 or more move to interviews by themselves.',
    ),
  ).toBeVisible();
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    shortlistScore: 70,
    callShortlisted: true,
    interviewScore: 75,
  });
});

it('sets up how the AI books a job’s interviews, and turns it off', async () => {
  const calls = stub((url) =>
    url.endsWith('/interviews/panelists')
      ? {
          data: [
            { id: 'u1', full_name: 'Riya Recruiter', role: 'RECRUITER' },
            { id: 'u2', full_name: 'Arjun Rao', role: 'INTERVIEWER' },
          ],
        }
      : {},
  );
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const { unmount } = renderWith(
    <InterviewBookingDialog
      job={{ id: 'job-1', title: 'Backend Developer', interview_setup: null }}
      onClose={() => undefined}
      onSaved={onSaved}
    />,
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Interview booking',
  });
  // Weekdays, 10:00 to 17:00, 45 minutes by default.
  expect(within(dialog).getByRole('checkbox', { name: 'Mon' })).toBeChecked();
  expect(
    within(dialog).getByRole('checkbox', { name: 'Sat' }),
  ).not.toBeChecked();
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(
    within(dialog).getByText('Choose at least one person for the panel.'),
  ).toBeVisible();
  await user.click(
    await within(dialog).findByRole('checkbox', { name: /Arjun Rao/ }),
  );
  await user.click(within(dialog).getByRole('checkbox', { name: 'Fri' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    interviewSetup: {
      round: 'Final round',
      minutes: 45,
      mode: 'VIDEO',
      panelistIds: ['u2'],
      days: [1, 2, 3, 4],
      startMinute: 600,
      endMinute: 1020,
    },
  });
  unmount();

  // Already set up: it can be turned off.
  renderWith(
    <InterviewBookingDialog
      job={{
        id: 'job-1',
        title: 'Backend Developer',
        interview_setup: {
          round: 'Final round',
          minutes: 45,
          mode: 'VIDEO',
          panelistIds: ['u2'],
          days: [1, 2, 3, 4],
          startMinute: 600,
          endMinute: 1020,
        },
      }}
      onClose={() => undefined}
      onSaved={onSaved}
    />,
  );
  await user.click(await screen.findByRole('button', { name: 'Turn off' }));
  await waitFor(() =>
    expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
      interviewSetup: null,
    }),
  );
});
