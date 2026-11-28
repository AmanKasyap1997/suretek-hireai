import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CloseJobDialog, PublishDialog, useJobChannels } from './JobChannels';

vi.setConfig({ testTimeout: 20000 });

const job = { id: 'job-1', title: 'Full Stack Developer', location: 'Noida' };
const ready = (channel: string, label: string) => ({
  channel,
  label,
  environment: 'production',
  ready: true,
  reason: null,
});
const live = (channel: string, label: string) => ({
  channel,
  label,
  status: 'PUBLISHED',
  url: `https://www.linkedin.com/feed/update/urn:li:share:${channel.length}/`,
  message: 'Posted on LinkedIn.',
});

function Share() {
  const query = useJobChannels(true);
  return (
    <PublishDialog
      job={job}
      mode="share"
      query={query}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />
  );
}

/** A fetch double whose history reflects removals, like the API does. */
function setup(
  ui: 'share' | 'close',
  options: { canRemove?: boolean; removeFails?: boolean } = {},
) {
  let history = [
    live('profile_post', 'LinkedIn profile post'),
    {
      ...live('job_listing', 'LinkedIn Jobs'),
      url: 'https://www.linkedin.com/jobs/view/123',
    },
  ];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs/publishing/channels'))
        return Response.json([
          ready('profile_post', 'LinkedIn profile post'),
          ready('job_listing', 'LinkedIn Jobs'),
        ]);
      if (
        url.endsWith('/jobs/job-1/channels/profile_post') &&
        init?.method === 'DELETE'
      ) {
        if (options.removeFails)
          return Response.json(
            {
              message:
                'LinkedIn didn’t allow removing this post. It may belong to another LinkedIn account; remove it on LinkedIn directly.',
            },
            { status: 502 },
          );
        history = history.map((entry) =>
          entry.channel === 'profile_post'
            ? {
                ...entry,
                status: 'REMOVED',
                url: null as unknown as string,
                message: 'Removed from LinkedIn. You can post it again.',
              }
            : entry,
        );
        return Response.json(history[0]);
      }
      if (url.endsWith('/jobs/job-1/channels')) return Response.json(history);
      if (url.endsWith('/jobs/job-1/close'))
        return Response.json({ ...job, status: 'CLOSED' });
      return Response.json({}, { status: 404 });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const onDone = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        {ui === 'share' ? (
          <Share />
        ) : (
          <CloseJobDialog
            job={job}
            canRemove={options.canRemove ?? true}
            onClose={vi.fn()}
            onDone={onDone}
          />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const requests = () =>
    fetcher.mock.calls.map(
      ([input, init]) =>
        `${init?.method ?? 'GET'} ${String(input).replace('/api/v1', '')}`,
    );
  return { onDone, requests };
}

afterEach(() => vi.unstubAllGlobals());

it('removes a LinkedIn post so the job can be posted there again', async () => {
  const { requests } = setup('share');
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  const profile = await within(dialog).findByRole('checkbox', {
    name: 'LinkedIn profile post',
  });
  await waitFor(() => expect(profile).toBeDisabled());
  // Only feed posts can be removed; a LinkedIn Jobs listing can't.
  expect(
    within(dialog).getAllByRole('button', { name: /Remove from LinkedIn/ }),
  ).toHaveLength(1);
  expect(
    within(dialog).getByText(/Already deleted it on LinkedIn\?/),
  ).toBeVisible();

  await userEvent.click(
    within(dialog).getByRole('button', { name: /Remove from LinkedIn/ }),
  );
  const confirm = within(dialog).getByRole('group', {
    name: 'Remove LinkedIn profile post',
  });
  expect(
    within(confirm).getByRole('button', { name: 'Keep post' }),
  ).toHaveFocus();
  expect(requests()).not.toContain('DELETE /jobs/job-1/channels/profile_post');
  await userEvent.click(
    within(confirm).getByRole('button', { name: 'Remove post' }),
  );

  expect(
    await within(dialog).findByText(
      'LinkedIn profile post removed from LinkedIn. You can post the job there again.',
    ),
  ).toBeVisible();
  await waitFor(() => expect(profile).toBeEnabled());
  expect(within(dialog).getByText('Removed', { exact: true })).toBeVisible();
  expect(
    within(dialog).queryByRole('button', { name: /Remove from LinkedIn/ }),
  ).not.toBeInTheDocument();
  expect(requests()).toContain('DELETE /jobs/job-1/channels/profile_post');
});

it('keeps the post listed and explains when LinkedIn refuses', async () => {
  setup('share', { removeFails: true });
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  await userEvent.click(
    await within(dialog).findByRole('button', { name: /Remove from LinkedIn/ }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Remove post' }),
  );
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'remove it on LinkedIn directly',
  );
  expect(
    within(dialog).getByRole('checkbox', { name: 'LinkedIn profile post' }),
  ).toBeDisabled();
  expect(
    within(dialog).getByRole('button', { name: 'Remove post' }),
  ).toBeEnabled();
});

it('closes a job and removes its LinkedIn post by default', async () => {
  const { onDone, requests } = setup('close');
  const dialog = screen.getByRole('dialog', { name: 'Close job' });
  expect(within(dialog).getByText(/can’t be reopened/)).toBeVisible();
  const remove = await within(dialog).findByRole('checkbox', {
    name: /Also remove it from LinkedIn/,
  });
  expect(remove).toBeChecked();
  expect(remove).toHaveAccessibleName(/Deletes the LinkedIn profile post/);
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Close job' }),
  );
  await waitFor(() =>
    expect(onDone).toHaveBeenCalledWith({
      removed: ['LinkedIn profile post'],
      failed: [],
    }),
  );
  // The job closes first; the post is removed after.
  const sent = requests().filter((r) => !r.startsWith('GET'));
  expect(sent).toEqual([
    'POST /jobs/job-1/close',
    'DELETE /jobs/job-1/channels/profile_post',
  ]);
});

it('can close a job and leave its LinkedIn post up', async () => {
  const { onDone, requests } = setup('close');
  const dialog = screen.getByRole('dialog', { name: 'Close job' });
  await userEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: /Also remove it from LinkedIn/,
    }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Close job' }),
  );
  await waitFor(() =>
    expect(onDone).toHaveBeenCalledWith({ removed: [], failed: [] }),
  );
  expect(requests()).not.toContain('DELETE /jobs/job-1/channels/profile_post');
});

it('reports a post that could not be removed after closing', async () => {
  const { onDone } = setup('close', { removeFails: true });
  const dialog = screen.getByRole('dialog', { name: 'Close job' });
  await within(dialog).findByRole('checkbox', {
    name: /Also remove it from LinkedIn/,
  });
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Close job' }),
  );
  await waitFor(() =>
    expect(onDone).toHaveBeenCalledWith({
      removed: [],
      failed: [
        {
          title: 'LinkedIn profile post',
          message: expect.stringContaining('remove it on LinkedIn directly'),
        },
      ],
    }),
  );
});

it('just confirms closing for users who cannot manage LinkedIn posts', async () => {
  const { onDone, requests } = setup('close', { canRemove: false });
  const dialog = screen.getByRole('dialog', { name: 'Close job' });
  expect(
    within(dialog).queryByRole('checkbox', {
      name: /Also remove it from LinkedIn/,
    }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Close job' }),
  );
  await waitFor(() =>
    expect(onDone).toHaveBeenCalledWith({ removed: [], failed: [] }),
  );
  expect(requests()).toEqual(['POST /jobs/job-1/close']);
});
