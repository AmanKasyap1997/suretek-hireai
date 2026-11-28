import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { JobBuilder } from './Jobs';

vi.setConfig({ testTimeout: 20000 });

const published = {
  id: 'job-1',
  title: 'Senior PHP Developer',
  description: 'Build and maintain Laravel services.',
  department: 'Engineering',
  location: 'Delhi-NCR',
  status: 'PUBLISHED' as const,
  openings: 1,
  employment_type: 'FULL_TIME',
  salary_min: null,
  salary_max: null,
  screening_criteria: [
    { id: 'php', label: 'PHP', weight: 50, must_have: true },
  ],
  auto_screen: true,
  call_questions: [
    {
      id: 'q1',
      text: 'Can you work from our Noida office?',
      answer_type: 'yes_no' as const,
      expected_answer: 'yes' as const,
      criterion_id: null,
      key_points: [],
    },
  ],
  created_at: '2026-11-20T09:00:00Z',
  updated_at: '2026-11-20T09:00:00Z',
};

function setup(canPublish: boolean) {
  const onSaved = vi.fn();
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs/ai-description/providers'))
        return Response.json([
          { provider: 'openai', label: 'OpenAI', environment: 'production' },
        ]);
      if (url.endsWith('/jobs/call-questions/settings'))
        return Response.json({ enabled: true, ai_available: true });
      if (url.endsWith('/jobs/publishing/channels')) return Response.json([]);
      if (url.endsWith('/api/v1/jobs/job-1') && init?.method === 'PATCH')
        return Response.json({ ...published, updated_at: new Date() });
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <JobBuilder
          initialJob={published}
          role={canPublish ? 'HR_ADMIN' : 'RECRUITER'}
          onCancel={vi.fn()}
          onSaved={onSaved}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const calls = () =>
    fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }));
  return { onSaved, calls };
}

afterEach(() => vi.unstubAllGlobals());

it('adds a call question to a published job and saves it, without publishing again', async () => {
  const { onSaved, calls } = setup(true);
  expect(
    screen.getByText(
      'This job is published: your changes show on the careers page as soon as you save them.',
    ),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    screen.getByText(/Changes here apply to new screenings and new AI calls/),
  ).toBeVisible();
  await userEvent.click(
    await screen.findByRole('button', { name: /Add call question/ }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Question 2' }),
    'Can you join within 30 days?',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Review changes')).toBeVisible();
  expect(
    screen.getByText(/Posts already shared to LinkedIn or other channels/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Publish Job' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const patch = calls().find((c) => c.method === 'PATCH')!;
  expect(patch.url).toBe('/api/v1/jobs/job-1');
  expect(patch.body).toMatchObject({
    title: 'Senior PHP Developer',
    callQuestions: [
      { id: 'q1', text: 'Can you work from our Noida office?' },
      { text: 'Can you join within 30 days?' },
    ],
  });
  expect(onSaved.mock.calls[0][1]).toBe(false);
  expect(
    calls().some((c) => /approve|publish$/.test(c.url) && c.method === 'POST'),
  ).toBe(false);
});

it('lets a recruiter change questions and criteria, with the details locked', async () => {
  const { onSaved, calls } = setup(false);
  expect(screen.getByRole('textbox', { name: /Job title/ })).toBeDisabled();
  expect(
    screen.getByRole('textbox', { name: /Job description/ }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Only an HR Admin can change these details/),
  ).toBeVisible();
  expect(
    await screen.findByRole('button', { name: /Generate with AI/ }),
  ).toBeDisabled();
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Add skill' }),
    'Laravel{enter}',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const patch = calls().find((c) => c.method === 'PATCH')!;
  expect(Object.keys(patch.body).sort()).toEqual([
    'autoScreen',
    'callQuestions',
    'screeningCriteria',
  ]);
  expect(
    patch.body.screeningCriteria.map((c: { label: string }) => c.label),
  ).toEqual(['PHP', 'Laravel']);
});
