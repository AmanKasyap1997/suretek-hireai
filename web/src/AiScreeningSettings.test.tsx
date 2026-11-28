import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AiCallingSettings, AiScreeningSettings } from './AiScreeningSettings';

vi.setConfig({ testTimeout: 20000 });

const providers = [
  { provider: 'openai', label: 'OpenAI', environment: 'sandbox' },
  { provider: 'anthropic', label: 'Anthropic', environment: 'production' },
  { provider: 'google_ai', label: 'Google AI Studio', environment: 'sandbox' },
];

function setup(
  settings: Record<string, unknown>,
  save: (body: Record<string, unknown>) => Response = (body) =>
    Response.json({
      ...settings,
      screening_provider: body.screeningProvider,
      screening_fallback: body.screeningFallback,
      problem: null,
    }),
) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) !== '/api/v1/organization/ai-settings')
        return Response.json({}, { status: 404 });
      if (init.method === 'PUT') return save(JSON.parse(String(init.body)));
      return Response.json(settings);
    },
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AiScreeningSettings />
    </QueryClientProvider>,
  );
  const saves = () =>
    fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)));
  return { saves };
}

afterEach(() => vi.unstubAllGlobals());

it('chooses one provider, without fallback unless the admin opts in', async () => {
  const { saves } = setup({
    screening_provider: null,
    screening_fallback: true,
    providers,
    problem: null,
  });
  const select = await screen.findByRole('combobox', {
    name: 'Screen resumes with',
  });
  expect(
    screen.getByRole('option', {
      name: 'Automatic: OpenAI, then Anthropic, then Google AI Studio',
    }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await userEvent.selectOptions(select, 'anthropic');
  const fallback = screen.getByRole('checkbox', {
    name: 'If Anthropic can’t be used, screen with another enabled provider',
  });
  // Off by default: every candidate is scored by the same AI.
  expect(fallback).not.toBeChecked();
  expect(
    screen.getByText(/Every candidate is scored by Anthropic/),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText('Saved. Anthropic now screens resumes.'),
  ).toBeVisible();
  expect(saves()).toEqual([
    { screeningProvider: 'anthropic', screeningFallback: false },
  ]);
});

it('saves automatic order with fallback, and backup when ticked', async () => {
  const { saves } = setup({
    screening_provider: 'openai',
    screening_fallback: false,
    providers,
    problem: null,
  });
  const select = await screen.findByRole('combobox', {
    name: 'Screen resumes with',
  });
  await userEvent.click(
    screen.getByRole('checkbox', {
      name: 'If OpenAI can’t be used, screen with another enabled provider',
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(saves()).toEqual([
      { screeningProvider: 'openai', screeningFallback: true },
    ]),
  );
  await userEvent.selectOptions(select, '');
  expect(
    screen.getByText(/HireAI tries each enabled provider in this order/),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(saves()[1]).toEqual({
      screeningProvider: null,
      screeningFallback: true,
    }),
  );
});

it('warns when the chosen provider is no longer enabled', async () => {
  setup({
    screening_provider: 'google_ai',
    screening_fallback: false,
    providers: providers.slice(0, 2),
    problem:
      'Google AI Studio is chosen for resume screening but isn’t enabled. Resumes aren’t screened until you enable it or choose another provider.',
  });
  expect(
    await screen.findByText(/Google AI Studio is chosen for resume screening/),
  ).toBeVisible();
  expect(
    screen.getByRole('option', { name: 'Google AI Studio (not enabled)' }),
  ).toBeVisible();
});

it('explains a refused save and asks to connect a provider first', async () => {
  setup(
    {
      screening_provider: null,
      screening_fallback: true,
      providers,
      problem: null,
    },
    () =>
      Response.json(
        {
          message:
            'Anthropic isn’t enabled. Connect, test and enable it before choosing it for resume screening.',
        },
        { status: 409 },
      ),
  );
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: 'Screen resumes with' }),
    'anthropic',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Anthropic isn’t enabled.',
  );
});

it('asks for an enabled provider when there is none', async () => {
  setup({
    screening_provider: null,
    screening_fallback: true,
    providers: [],
    problem: null,
  });
  expect(
    await screen.findByText(
      'Connect, test and enable an AI provider above to screen resumes.',
    ),
  ).toBeVisible();
});

const calling = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  voice_providers: [
    { provider: 'openai', label: 'OpenAI Realtime' },
    { provider: 'google_ai', label: 'Gemini Live' },
  ],
  voice: { provider: 'openai', label: 'OpenAI Realtime' },
  phone: null,
  voice_problem: null,
  problems: [
    'Connect, test and enable Plivo (Communication) so HireAI can phone candidates.',
  ],
  ...overrides,
});

it('turns AI calling on and shows what phone calls still need', async () => {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const settings = {
        screening_provider: null,
        screening_fallback: true,
        providers,
        problem: null,
        calling_enabled: init.method === 'PUT',
        calling_provider: null,
        calling: calling(),
      };
      if (String(input).startsWith('/api/v1/organization/ai-settings'))
        return Response.json(settings);
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCallingSettings />
    </QueryClientProvider>,
  );
  const toggle = await screen.findByRole('checkbox', {
    name: 'Turn on AI calling and job call questions',
  });
  expect(screen.getByText('Off')).toBeVisible();
  expect(toggle).not.toBeChecked();
  expect(screen.queryByLabelText('Voice AI')).toBeNull();
  await userEvent.click(toggle);
  expect(
    await screen.findByText(
      'AI calling is on. Recruiters can call shortlisted candidates and prepare each job’s questions.',
    ),
  ).toBeVisible();
  expect(toggle).toBeChecked();
  expect(screen.getByText('Setup needed')).toBeVisible();
  expect(
    screen.getByText(
      'Connect, test and enable Plivo (Communication) so HireAI can phone candidates.',
    ),
  ).toBeVisible();
  expect(screen.getByText('Not connected')).toBeVisible();
  const [url, init] = fetcher.mock.calls.find(
    ([, request]) => request?.method === 'PUT',
  )!;
  expect(String(url)).toBe('/api/v1/organization/ai-settings/calling');
  expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
});

it('chooses the voice AI and offers a test call when ready', async () => {
  let chosen: string | null = null;
  let assistantName: string | null = null;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      // Like the server: a voice-only change keeps the chosen voice AI.
      if (body.provider !== undefined) chosen = body.provider;
      if (body.assistantName !== undefined) assistantName = body.assistantName;
      const settings = {
        screening_provider: null,
        screening_fallback: true,
        providers,
        problem: null,
        calling_enabled: true,
        calling_provider: chosen,
        calling_assistant_name: assistantName,
        calling: calling({
          phone: {
            provider: 'plivo',
            environment: 'production',
            number: '+918045671234',
          },
          voice: chosen
            ? {
                provider: 'google_ai',
                label: 'Gemini Live',
                name: body.voice ?? null,
                voices: [
                  { id: 'Sulafat', label: 'Sulafat · warm' },
                  { id: 'Kore', label: 'Kore · firm' },
                ],
              }
            : { provider: 'openai', label: 'OpenAI Realtime' },
          problems: [],
        }),
      };
      if (String(input).startsWith('/api/v1/organization/ai-settings'))
        return Response.json(settings);
      if (String(input).startsWith('/api/v1/jobs'))
        return Response.json({ data: [], total: 0 });
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCallingSettings />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Ready to call')).toBeVisible();
  expect(screen.getByText('Plivo · +918045671234')).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText('Voice AI'), 'google_ai');
  expect(
    await screen.findByText('Saved. Gemini Live talks to candidates.'),
  ).toBeVisible();
  const put = fetcher.mock.calls.find(
    ([, request]) => request?.method === 'PUT',
  )!;
  expect(JSON.parse(String(put[1]?.body))).toEqual({
    enabled: true,
    provider: 'google_ai',
  });
  // Then a voice that sounds warmer.
  fetcher.mockClear();
  await userEvent.selectOptions(screen.getByLabelText('Voice'), 'Sulafat');
  expect(
    await screen.findByText(
      'Saved. Calls use Sulafat · warm. Try a test call to hear it.',
    ),
  ).toBeVisible();
  const voicePut = fetcher.mock.calls.find(
    ([, request]) => request?.method === 'PUT',
  )!;
  expect(JSON.parse(String(voicePut[1]?.body))).toEqual({
    enabled: true,
    voice: 'Sulafat',
  });
  // The name the AI introduces itself with.
  fetcher.mockClear();
  const nameField = screen.getByLabelText('Assistant name');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  await userEvent.type(nameField, ' Priya ');
  expect(screen.getByText(/Hi, this is Priya from/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(
    await screen.findByText(
      'Saved. The AI introduces itself as Priya. Try a test call to hear it.',
    ),
  ).toBeVisible();
  const namePut = fetcher.mock.calls.find(
    ([, request]) => request?.method === 'PUT',
  )!;
  expect(JSON.parse(String(namePut[1]?.body))).toEqual({
    enabled: true,
    assistantName: 'Priya',
  });
  expect(nameField).toHaveValue('Priya');
  await userEvent.click(
    screen.getByRole('button', { name: 'Try a test call' }),
  );
  expect(
    await screen.findByRole('dialog', { name: 'Try an AI call' }),
  ).toBeVisible();
  expect(
    await screen.findByRole('option', {
      name: 'No job has call questions yet',
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Start test call' }),
  ).toBeDisabled();
});
