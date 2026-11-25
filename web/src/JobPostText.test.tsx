import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  POST_TEXT_LIMIT,
  PublishDialog,
  postTextFromJob,
  useJobChannels,
} from './JobChannels';

vi.setConfig({ testTimeout: 20000 });

const description = [
  'About the role:',
  'We are looking for a Full Stack Developer.',
  '',
  '',
  '',
  'Key responsibilities:',
  '- Build APIs with Laravel',
  '* Ship React features',
  '',
  'We look forward to your application.',
].join('\r\n');

afterEach(() => vi.unstubAllGlobals());

it('turns the job description into LinkedIn post text', () => {
  expect(
    postTextFromJob({
      title: 'Full Stack Developer',
      location: 'Noida, INDIA ( Remote )',
      description,
    }),
  ).toBe(
    [
      'We are hiring: Full Stack Developer — Noida, INDIA ( Remote )',
      '',
      'About the role:',
      'We are looking for a Full Stack Developer.',
      '',
      'Key responsibilities:',
      '• Build APIs with Laravel',
      '• Ship React features',
      '',
      'We look forward to your application.',
      '',
      'Apply using the link below.',
    ].join('\n'),
  );
  expect(postTextFromJob({ title: 'QA Engineer', location: 'Delhi' })).toBe(
    'We are hiring: QA Engineer — Delhi\n\nApply using the link below.',
  );
});

it('cuts a long description at a whole line to fit one post', () => {
  const lines = Array.from(
    { length: 200 },
    (_, i) => `- Responsibility ${i + 1}: own a part of the hiring platform.`,
  );
  const text = postTextFromJob({
    title: 'Full Stack Developer',
    location: 'Noida',
    description: lines.join('\n'),
  });
  expect(text.length).toBeLessThanOrEqual(POST_TEXT_LIMIT);
  expect(text).toMatch(
    /own a part of the hiring platform\.…\n\nRead the full description and apply using the link below\.$/,
  );

  const oneLine = postTextFromJob({
    title: 'Full Stack Developer',
    location: 'Noida',
    description: 'Laravel '.repeat(600),
  });
  expect(oneLine.length).toBeLessThanOrEqual(POST_TEXT_LIMIT);
  expect(oneLine).toContain('Laravel…\n\nRead the full description');
});

function Share() {
  const query = useJobChannels(true);
  return (
    <PublishDialog
      job={{
        id: 'job-1',
        title: 'Full Stack Developer',
        location: 'Noida',
        description,
      }}
      mode="share"
      query={query}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />
  );
}

it('pre-fills the post from the job and keeps the admin’s edits', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/jobs/publishing/channels')
        ? Response.json([
            {
              channel: 'profile_post',
              label: 'LinkedIn profile post',
              environment: 'production',
              ready: true,
              reason: null,
            },
          ])
        : Response.json([]),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <Share />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  const profile = await within(dialog).findByRole('checkbox', {
    name: 'LinkedIn profile post',
  });
  await userEvent.click(profile);
  const text = within(dialog).getByRole('textbox', { name: 'Post text' });
  const fromJob = postTextFromJob({
    title: 'Full Stack Developer',
    location: 'Noida',
    description,
  });
  expect(text).toHaveValue(fromJob);
  expect(text).toHaveAccessibleDescription(
    /LinkedIn shows the first few lines/,
  );
  expect(
    within(dialog).getByText(`${fromJob.length} / 3,000`),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: 'Use the job description' }),
  ).not.toBeInTheDocument();

  await userEvent.clear(text);
  await userEvent.type(text, 'Join us in Noida');
  // Re-selecting the channel doesn't overwrite the admin's text.
  await userEvent.click(profile);
  await userEvent.click(profile);
  expect(
    within(dialog).getByRole('textbox', { name: 'Post text' }),
  ).toHaveValue('Join us in Noida');

  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Use the job description' }),
  );
  expect(
    within(dialog).getByRole('textbox', { name: 'Post text' }),
  ).toHaveValue(fromJob);
});
