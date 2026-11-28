import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { JobBuilder } from './Jobs';

// These flows type into several fields; allow for slower CI workers.
vi.setConfig({ testTimeout: 20000 });

type Provider = { provider: string; label: string; environment: string };
type Options = {
  channels?: Record<string, unknown>[];
  /** AI calling is on, so the wizard has call questions. */
  calling?: boolean;
  /** Drafting call questions fails with this message. */
  draftError?: string;
  onSaved?: Parameters<typeof JobBuilder>[0]['onSaved'];
};
const savedJob = (status: string) => ({
  id: 'job-1',
  title: 'Senior PHP Developer',
  description: 'Build and maintain Laravel services.',
  department: 'Engineering',
  location: 'Delhi-NCR',
  status,
  openings: 1,
  employment_type: 'FULL_TIME',
  salary_min: null,
  salary_max: null,
  screening_criteria: [],
  created_at: '2026-11-20T09:00:00Z',
  updated_at: '2026-11-20T09:00:00Z',
});

function setup(
  providers: Provider[] = [],
  generate: (body: Record<string, unknown>) => Response = (body) =>
    Response.json({
      description: `About the role:\nJoin us as a ${String(body.title)}.`,
      provider: body.provider,
      label: body.provider === 'anthropic' ? 'Anthropic' : 'OpenAI',
      environment: 'sandbox',
      model: 'test-model',
    }),
  options: Options = {},
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs/ai-description/providers'))
        return Response.json(providers);
      if (url.endsWith('/jobs/ai-description') && init?.method === 'POST')
        return generate(JSON.parse(String(init.body)));
      if (url.endsWith('/jobs/call-questions/settings'))
        return options.calling
          ? Response.json({ enabled: true, ai_available: true })
          : Response.json({ enabled: false, ai_available: true });
      if (
        url.endsWith('/jobs/call-questions') &&
        init?.method === 'POST' &&
        options.draftError
      )
        return Response.json({ message: options.draftError }, { status: 502 });
      if (url.endsWith('/jobs/call-questions') && init?.method === 'POST')
        return Response.json({
          questions: [
            {
              id: 'q1',
              text: 'Are you comfortable working night shifts twice a month?',
              answer_type: 'yes_no',
              expected_answer: 'yes',
              criterion_id: null,
            },
            {
              id: 'q2',
              text: 'How many years have you used Laravel queues?',
              answer_type: 'number',
              expected_answer: null,
              criterion_id: null,
            },
          ],
          label: 'Anthropic',
          environment: 'production',
        });
      if (url.endsWith('/jobs/publishing/channels'))
        return Response.json(options.channels ?? []);
      if (url.endsWith('/api/v1/jobs') && init?.method === 'POST')
        return Response.json(savedJob('DRAFT'));
      if (url.endsWith('/jobs/job-1/approve'))
        return Response.json(savedJob('APPROVED'));
      if (url.endsWith('/jobs/job-1/publish'))
        return Response.json(savedJob('PUBLISHED'));
      if (url.endsWith('/jobs/job-1/channels'))
        return Response.json({
          results: [
            {
              channel: 'careers_website',
              label: 'Careers website',
              status: 'PUBLISHED',
              url: 'https://careers.example.com/jobs/42',
              message: 'Sent to your careers website.',
            },
          ],
        });
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
          initialJob={null}
          role="HR_ADMIN"
          onCancel={vi.fn()}
          onSaved={options.onSaved ?? vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const posts = () =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST' && init.body)
      .map(([, init]) => JSON.parse(String(init?.body)));
  const requested = (path: string) =>
    fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith(path))
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
  return { posts, requested };
}

async function goToPublish() {
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Build and maintain Laravel services.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

const channel = (
  id: string,
  label: string,
  ready = true,
  reason: string | null = null,
) => ({ channel: id, label, environment: 'production', ready, reason });

async function fillDetails() {
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job title/ }),
    'Senior PHP Developer',
  );
  await userEvent.type(
    screen.getByRole('combobox', { name: /Department/ }),
    'Engineering',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /Location/ }),
    'Delhi-NCR',
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('shows that AI calling is on, and goes to the job’s call questions', async () => {
  setup([], undefined, { calling: true });
  const panel = (
    await screen.findByRole('heading', { name: 'AI Calling' })
  ).closest('section')!;
  expect(await within(panel).findByText('On')).toBeVisible();
  expect(within(panel).getByText('None yet')).toBeVisible();
  expect(
    within(panel).getByText(/English or Hindi, chosen when a recruiter/),
  ).toBeVisible();
  await fillDetails();
  await userEvent.click(
    within(panel).getByRole('button', { name: 'Add questions' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Screening criteria' }),
  ).toBeVisible();
});

it('says when AI calling is off for the organization', async () => {
  setup([], undefined, { calling: false });
  const panel = (
    await screen.findByRole('heading', { name: 'AI Calling' })
  ).closest('section')!;
  expect(
    await within(panel).findByText(/AI calling is off for your organization/),
  ).toBeVisible();
  expect(within(panel).getByText('Off')).toBeVisible();
  expect(
    within(panel).getByRole('link', { name: /Turn it on/ }),
  ).toHaveAttribute('href', '/integrations');
});

it('adds and removes skills inline without advancing the job wizard', async () => {
  setup();
  const input = screen.getByRole('textbox', { name: 'Add skill' });
  await userEvent.click(screen.getByRole('button', { name: 'Add Skill' }));
  expect(input).toHaveFocus();
  await userEvent.type(input, 'PHP');
  await userEvent.click(screen.getByRole('button', { name: 'Add Skill' }));
  expect(screen.getByRole('button', { name: 'Remove PHP' })).toBeVisible();
  expect(input).toBeVisible();
  await userEvent.type(input, 'Laravel{Enter}');
  expect(screen.getByRole('button', { name: 'Remove Laravel' })).toBeVisible();
  await userEvent.type(input, ' php {Enter}');
  expect(screen.getAllByRole('button', { name: 'Remove PHP' })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Remove PHP' }));
  expect(screen.queryByRole('button', { name: 'Remove PHP' })).toBeNull();
  expect(input).toBeVisible();
});

it('explains how to enable AI drafting when no provider is enabled', async () => {
  setup([]);
  const generate = screen.getByRole('button', { name: /Generate with AI/ });
  await waitFor(() =>
    expect(generate).toHaveAttribute(
      'title',
      expect.stringContaining('Ask an HR Admin'),
    ),
  );
  expect(generate).toBeDisabled();
  expect(
    screen.getByText(
      'An HR Admin must enable an AI provider (OpenAI, Anthropic or Google AI Studio) in Integrations.',
    ),
  ).toBeVisible();
});

it('remembers the chosen AI provider for the next job', async () => {
  const providers = [
    { provider: 'openai', label: 'OpenAI', environment: 'sandbox' },
    { provider: 'anthropic', label: 'Anthropic', environment: 'sandbox' },
    {
      provider: 'google_ai',
      label: 'Google AI Studio',
      environment: 'sandbox',
    },
  ];
  const first = setup(providers);
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: 'AI provider' }),
    'google_ai',
  );
  cleanup();
  setup(providers);
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    await screen.findByRole('combobox', { name: 'AI provider' }),
  ).toHaveValue('google_ai');
  expect(
    screen.getByRole('option', { name: 'Google AI Studio (sandbox)' }),
  ).toBeVisible();
  expect(first.posts()).toEqual([]);
});

it('generates a description from the job details with the chosen provider', async () => {
  const { posts } = setup([
    { provider: 'openai', label: 'OpenAI', environment: 'production' },
    { provider: 'anthropic', label: 'Anthropic', environment: 'sandbox' },
  ]);
  await fillDetails();
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Add skill' }),
    'Laravel{Enter}',
  );
  const generate = screen.getByRole('button', { name: /Generate with AI/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'AI provider' }),
    'anthropic',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Guidance for AI (optional)' }),
    'Hybrid, 4-6 years',
  );
  await userEvent.click(
    screen.getByRole('button', { name: /Generate description/ }),
  );
  const description = screen.getByRole('textbox', { name: /^Description/ });
  await waitFor(() =>
    expect(description).toHaveValue(
      'About the role:\nJoin us as a Senior PHP Developer.',
    ),
  );
  expect(
    screen.getByText(/Draft generated with Anthropic \(sandbox\)/),
  ).toBeVisible();
  expect(posts()).toEqual([
    {
      provider: 'anthropic',
      title: 'Senior PHP Developer',
      department: 'Engineering',
      location: 'Delhi-NCR',
      employmentType: 'FULL_TIME',
      openings: 1,
      salaryMin: null,
      salaryMax: null,
      skills: ['Laravel'],
      guidance: 'Hybrid, 4-6 years',
    },
  ]);
  await userEvent.click(
    screen.getByRole('button', { name: 'Restore previous description' }),
  );
  expect(description).toHaveValue('');
});

it('uses a written description as the starting point and reports provider errors', async () => {
  const { posts } = setup(
    [{ provider: 'openai', label: 'OpenAI', environment: 'sandbox' }],
    () =>
      Response.json(
        { message: 'OpenAI is limiting requests right now.' },
        { status: 429 },
      ),
  );
  await fillDetails();
  await userEvent.type(
    screen.getByRole('textbox', { name: /Job description/ }),
    'We build HR software.',
  );
  const generate = screen.getByRole('button', { name: /Generate with AI/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await userEvent.click(generate);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'OpenAI is limiting requests right now.',
  );
  expect(posts()[0]).toMatchObject({
    provider: 'openai',
    currentDescription: 'We build HR software.',
  });
  expect(screen.getByRole('textbox', { name: /^Description/ })).toHaveValue(
    'We build HR software.',
  );
});

it('asks for the job details before generating', async () => {
  const { posts } = setup([
    { provider: 'openai', label: 'OpenAI', environment: 'sandbox' },
  ]);
  const generate = screen.getByRole('button', { name: /Generate with AI/ });
  await waitFor(() => expect(generate).toBeEnabled());
  await userEvent.click(generate);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Enter a job title.',
  );
  expect(posts()).toEqual([]);
});

it('publishes the job to the channels an HR Admin picks', async () => {
  const onSaved = vi.fn();
  const { posts, requested } = setup([], undefined, {
    onSaved,
    channels: [
      channel('careers_website', 'Careers website'),
      channel(
        'company_announcement',
        'LinkedIn company page post',
        false,
        'Only the sandbox LinkedIn connection is enabled.',
      ),
      channel('job_listing', 'LinkedIn Jobs'),
    ],
  });
  await goToPublish();
  const careers = await screen.findByRole('checkbox', {
    name: 'Careers website',
  });
  expect(
    screen.getByRole('checkbox', { name: 'LinkedIn company page post' }),
  ).toBeDisabled();
  expect(
    screen.getByText('Only the sandbox LinkedIn connection is enabled.'),
  ).toBeVisible();
  // Choosing a channel replaces "Only in HireAI".
  const hireaiOnly = screen.getByRole('checkbox', { name: 'Only in HireAI' });
  await userEvent.click(hireaiOnly);
  await userEvent.click(careers);
  expect(hireaiOnly).not.toBeChecked();
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'LinkedIn Jobs' }),
  );
  expect(
    screen.getByRole('textbox', { name: 'Application page URL' }),
  ).toHaveAccessibleDescription(/Leave blank to use the job’s page/);
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Confirm that you’ve reviewed the job before posting it publicly.',
  );
  expect(posts()).toEqual([]);
  await userEvent.click(
    screen.getByRole('checkbox', { name: /authorize posting it publicly/ }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(requested('/jobs/job-1/channels')).toEqual([
    { channels: ['careers_website', 'job_listing'], confirmed: true },
  ]);
  expect(onSaved).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'PUBLISHED' }),
    true,
    {
      results: [
        expect.objectContaining({
          channel: 'careers_website',
          status: 'PUBLISHED',
        }),
      ],
    },
  );
});

it('needs a public application link for LinkedIn-only posts', async () => {
  const { requested } = setup([], undefined, {
    channels: [channel('job_listing', 'LinkedIn Jobs')],
  });
  await goToPublish();
  await userEvent.click(
    await screen.findByRole('checkbox', { name: 'LinkedIn Jobs' }),
  );
  await userEvent.click(
    screen.getByRole('checkbox', { name: /authorize posting it publicly/ }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Add the application page URL.',
  );
  const link = screen.getByRole('textbox', { name: /Application page URL/ });
  await userEvent.type(link, 'http://careers.example.com/jobs/1');
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'public https:// link',
  );
  expect(requested('/api/v1/jobs')).toEqual([]);
});

it('publishes in HireAI only and explains how to add channels', async () => {
  const onSaved = vi.fn();
  const { requested } = setup([], undefined, { onSaved });
  await goToPublish();
  expect(
    await screen.findByText(/No other channels are enabled/),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
    'href',
    '/integrations',
  );
  // Where to publish is required, even when HireAI is the only option.
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose where to publish this job',
  );
  expect(requested('/api/v1/jobs')).toEqual([]);
  expect(onSaved).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Only in HireAI' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Publish Job' }));
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PUBLISHED' }),
      true,
      undefined,
    ),
  );
  expect(requested('/jobs/job-1/channels')).toEqual([]);
});

it('publishes only from the review step, where destinations are chosen', async () => {
  const { requested } = setup([], undefined, {
    channels: [channel('careers_website', 'Careers website')],
  });
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Build and maintain Laravel services.',
  );
  expect(
    screen.queryByRole('button', { name: 'Publish Job' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    screen.queryByRole('button', { name: 'Publish Job' }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    await screen.findByRole('group', { name: /Where to publish/ }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Publish Job' })).toBeVisible();
  expect(requested('/api/v1/jobs')).toEqual([]);
});

it('saves whether new applications are screened with AI', async () => {
  const { requested } = setup([
    { provider: 'anthropic', label: 'Anthropic', environment: 'production' },
  ]);
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Build and maintain Laravel services.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const toggle = screen.getByRole('checkbox', {
    name: /Screen new applications with AI/,
  });
  // On by default, explained with the provider that will do it.
  expect(toggle).toBeChecked();
  expect(
    screen.getByText(/Anthropic rates each resume against these criteria/),
  ).toBeVisible();
  expect(
    screen.getByText(/the AI picks the key requirements from the description/),
  ).toBeVisible();
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() =>
    expect(requested('/api/v1/jobs')[0]).toMatchObject({ autoScreen: false }),
  );
});

it('drafts AI call questions for review when AI calling is on', async () => {
  const { requested } = setup(
    [{ provider: 'anthropic', label: 'Anthropic', environment: 'production' }],
    undefined,
    { calling: true },
  );
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Build and maintain Laravel services. Night shifts twice a month.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Drafted automatically on reaching the step, for the recruiter to edit.
  expect(
    await screen.findByDisplayValue(
      'Are you comfortable working night shifts twice a month?',
    ),
  ).toBeVisible();
  expect(screen.getByText(/Questions drafted with Anthropic/)).toBeVisible();
  expect(requested('/jobs/call-questions')[0]).toMatchObject({
    provider: 'anthropic',
    title: 'Senior PHP Developer',
    description:
      'Build and maintain Laravel services. Night shifts twice a month.',
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Remove call question 2' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: /Add call question/ }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Question 2' }),
    'What does a service provider do in Laravel?',
  );
  // New questions are spoken (technical) ones, with key points to assess.
  await userEvent.type(
    screen.getByRole('textbox', { name: /What a good answer covers/ }),
    'Registers bindings{enter}{enter}boot() runs after register',
  );
  const answers = screen.getAllByRole('combobox', { name: 'Answer' });
  expect(answers[1]).toHaveValue('text');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  // Listed on the review step before publishing.
  expect(screen.getByText('AI call questions')).toBeVisible();
  expect(screen.getByText(/flagged unless “Yes”/)).toBeVisible();
  expect(screen.getByText(/2 key points/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() =>
    expect(requested('/api/v1/jobs')[0]).toMatchObject({
      callQuestions: [
        {
          id: 'q1',
          text: 'Are you comfortable working night shifts twice a month?',
          answer_type: 'yes_no',
          expected_answer: 'yes',
          criterion_id: null,
        },
        {
          id: 'question-1',
          text: 'What does a service provider do in Laravel?',
          answer_type: 'text',
          expected_answer: null,
          criterion_id: null,
          key_points: ['Registers bindings', 'boot() runs after register'],
        },
      ],
    }),
  );
});

it('has no call questions while AI calling is off', async () => {
  const { requested } = setup([
    { provider: 'anthropic', label: 'Anthropic', environment: 'production' },
  ]);
  await goToPublish();
  expect(screen.queryByText('AI call questions')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(requested('/api/v1/jobs')).toHaveLength(1));
  expect(requested('/api/v1/jobs')[0]).not.toHaveProperty('callQuestions');
  expect(requested('/jobs/call-questions')).toEqual([]);
});

async function reachCallQuestions() {
  await fillDetails();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /^Description/ }),
    'Build and maintain Laravel services. Night shifts twice a month.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

it('drafts call questions with the provider picked in “Draft with”', async () => {
  const { requested } = setup(
    [
      {
        provider: 'google_ai',
        label: 'Google AI Studio',
        environment: 'sandbox',
      },
      { provider: 'anthropic', label: 'Anthropic', environment: 'production' },
    ],
    undefined,
    { calling: true },
  );
  await reachCallQuestions();
  await screen.findByText(/Questions drafted with/);
  // The first provider listed (the one chosen for screening) by default.
  expect(requested('/jobs/call-questions')[0]).toMatchObject({
    provider: 'google_ai',
  });
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Draft with' }),
    'anthropic',
  );
  await userEvent.click(
    screen.getByRole('button', { name: /Regenerate with AI/ }),
  );
  await waitFor(() =>
    expect(requested('/jobs/call-questions')[1]).toMatchObject({
      provider: 'anthropic',
    }),
  );
});

it('suggests another provider when drafting fails', async () => {
  setup(
    [
      { provider: 'anthropic', label: 'Anthropic', environment: 'production' },
      {
        provider: 'google_ai',
        label: 'Google AI Studio',
        environment: 'sandbox',
      },
    ],
    undefined,
    {
      calling: true,
      draftError:
        'Your organization’s Anthropic account has run out of credits or reached its usage limit.',
    },
  );
  await reachCallQuestions();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Anthropic account has run out of credits or reached its usage limit. Choose another provider in “Draft with” and try again, or add the questions yourself.',
  );
  // Questions can still be written by hand.
  expect(
    screen.getByRole('button', { name: /Add call question/ }),
  ).toBeVisible();
});
