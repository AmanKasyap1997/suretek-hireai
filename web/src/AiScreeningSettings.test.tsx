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

it('turns AI calling on, saying that calls aren’t placed yet', async () => {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const settings = {
        screening_provider: null,
        screening_fallback: true,
        providers,
        problem: null,
        calling_enabled: init.method === 'PUT',
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
  expect(screen.getByText(/Calls aren’t placed yet/)).toBeVisible();
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);
  expect(
    await screen.findByText(
      'AI calling is on. Recruiters now see call questions on each job.',
    ),
  ).toBeVisible();
  expect(toggle).toBeChecked();
  const [url, init] = fetcher.mock.calls.find(
    ([, request]) => request?.method === 'PUT',
  )!;
  expect(String(url)).toBe('/api/v1/organization/ai-settings/calling');
  expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
});
