import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelResults, PublishDialog, useJobChannels } from './JobChannels';

vi.setConfig({ testTimeout: 20000 });

const job = { id: 'job-1', title: 'Senior PHP Developer', location: 'Noida' };
const ready = (channel: string, label: string) => ({
  channel,
  label,
  environment: 'production',
  ready: true,
  reason: null,
});
const posted = {
  channel: 'job_listing',
  label: 'LinkedIn Jobs',
  status: 'PUBLISHED',
  url: 'https://www.linkedin.com/jobs/view/123',
  message: 'Posted on LinkedIn.',
};

function Harness(props: {
  mode: 'publish' | 'share';
  onDone: (outcome: unknown) => void;
  applyUrl?: string;
}) {
  const query = useJobChannels(true);
  return (
    <PublishDialog
      job={job}
      mode={props.mode}
      query={query}
      onClose={vi.fn()}
      onDone={props.onDone}
      applyUrl={props.applyUrl}
    />
  );
}

function setup(mode: 'publish' | 'share', applyUrl?: string) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs/publishing/channels'))
        return Response.json([
          ready('company_announcement', 'LinkedIn company page post'),
          ready('profile_post', 'LinkedIn profile post'),
          ready('job_listing', 'LinkedIn Jobs'),
        ]);
      if (url.endsWith('/jobs/job-1/channels') && init?.method === 'POST')
        return Response.json({
          results: [
            {
              channel: 'company_announcement',
              label: 'LinkedIn company page post',
              status: 'PUBLISHED',
              url: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
              message: 'Posted on LinkedIn.',
            },
          ],
        });
      if (url.endsWith('/jobs/job-1/channels')) return Response.json([posted]);
      if (url.includes('/organization/integrations/linkedin/pages'))
        return Response.json({
          pages: [{ urn: 'urn:li:organization:123', name: 'Suretek Infosoft' }],
          nextStart: null,
        });
      if (url.endsWith('/jobs/job-1/publish'))
        return Response.json({ ...job, status: 'PUBLISHED' });
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
        <Harness mode={mode} onDone={onDone} applyUrl={applyUrl} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const calls = (path: string, method = 'POST') =>
    fetcher.mock.calls
      .filter(
        ([input, init]) =>
          String(input).endsWith(path) && init?.method === method,
      )
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
  return { onDone, calls };
}

afterEach(() => vi.unstubAllGlobals());

it('posts a published job to a LinkedIn company page it has not used yet', async () => {
  const { onDone, calls } = setup('share');
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  const listing = await within(dialog).findByRole('checkbox', {
    name: 'LinkedIn Jobs',
  });
  await waitFor(() => expect(listing).toBeDisabled());
  expect(within(dialog).getByText('Posted', { exact: true })).toBeVisible();
  expect(
    within(dialog).getByRole('link', { name: /View on LinkedIn/ }),
  ).toHaveAttribute('href', posted.url);
  await userEvent.click(
    within(dialog).getByRole('checkbox', {
      name: 'LinkedIn company page post',
    }),
  );
  await userEvent.selectOptions(
    await within(dialog).findByRole('combobox', { name: 'Company page' }),
    'urn:li:organization:123',
  );
  const text = within(dialog).getByRole('textbox', { name: 'Post text' });
  // The post starts from the job, and can be replaced.
  expect(text).toHaveValue('We are hiring: Senior PHP Developer — Noida');
  await userEvent.clear(text);
  await userEvent.type(text, 'Join our platform team!');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: /Application page URL/ }),
    'https://careers.example.com/jobs/1',
  );
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: /authorize posting/ }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: /Post to selected channels/ }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(calls('/jobs/job-1/channels')).toEqual([
    {
      channels: ['company_announcement'],
      applicationUrl: 'https://careers.example.com/jobs/1',
      pageUrn: 'urn:li:organization:123',
      pageStart: 0,
      commentary: 'Join our platform team!',
      confirmed: true,
    },
  ]);
  expect(calls('/jobs/job-1/publish')).toEqual([]);
});

it('links a LinkedIn post to HireAI’s apply page without typing a link', async () => {
  const applyPage =
    'https://hireai.example.com/console/careers/acme/jobs/job-1?source=linkedin';
  const { onDone, calls } = setup('share', applyPage);
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  await userEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: 'LinkedIn profile post',
    }),
  );
  expect(within(dialog).getByRole('note')).toHaveTextContent(
    'Candidates apply on HireAI.',
  );
  expect(within(dialog).getByRole('link', { name: applyPage })).toBeVisible();
  // Only needed if candidates should apply elsewhere.
  expect(
    within(dialog).getByRole('textbox', {
      name: 'Another application page (optional)',
    }),
  ).toHaveValue('');
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: /authorize posting/ }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: /Post to selected channels/ }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(calls('/jobs/job-1/channels')[0]).toMatchObject({
    channels: ['profile_post'],
    applicationUrl: applyPage,
  });
});

it('passes HireAI’s localhost apply page while testing, and says so', async () => {
  const local =
    'http://localhost:5173/console/careers/acme/jobs/job-1?source=linkedin';
  const { onDone, calls } = setup('share', local);
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  await userEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: 'LinkedIn profile post',
    }),
  );
  expect(within(dialog).getByRole('link', { name: local })).toBeVisible();
  expect(within(dialog).getByRole('note')).toHaveTextContent(
    'candidates on LinkedIn can’t open it',
  );
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: /authorize posting/ }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: /Post to selected channels/ }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(calls('/jobs/job-1/channels')[0]).toMatchObject({
    applicationUrl: local,
  });
});

it('posts on the connected LinkedIn profile, visible to connections only', async () => {
  const { onDone, calls } = setup('share');
  const dialog = screen.getByRole('dialog', { name: 'Post to channels' });
  await userEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: 'LinkedIn profile post',
    }),
  );
  expect(
    within(dialog).queryByRole('combobox', { name: 'Company page' }),
  ).not.toBeInTheDocument();
  const visibility = within(dialog).getByRole('combobox', {
    name: 'Who can see the profile post',
  });
  expect(visibility).toHaveValue('PUBLIC');
  await userEvent.selectOptions(visibility, 'CONNECTIONS');
  const text = within(dialog).getByRole('textbox', { name: 'Post text' });
  await userEvent.clear(text);
  await userEvent.type(text, 'We’re hiring in Noida');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: /Application page URL/ }),
    'https://careers.example.com/jobs/1',
  );
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: /authorize posting/ }),
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: /Post to selected channels/ }),
  );
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(calls('/jobs/job-1/channels')).toEqual([
    {
      channels: ['profile_post'],
      applicationUrl: 'https://careers.example.com/jobs/1',
      commentary: 'We’re hiring in Noida',
      visibility: 'CONNECTIONS',
      confirmed: true,
    },
  ]);
});

it('asks for a channel before posting an already published job', async () => {
  const { calls } = setup('share');
  // The job is already in HireAI, so there is no "Only in HireAI" choice.
  await screen.findByRole('checkbox', { name: 'LinkedIn Jobs' });
  expect(
    screen.queryByRole('checkbox', { name: 'Only in HireAI' }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: /Post to selected channels/ }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose at least one channel.',
  );
  expect(calls('/jobs/job-1/channels')).toEqual([]);
});

it('publishes an approved job only in HireAI once that is chosen', async () => {
  const { onDone, calls } = setup('publish');
  await screen.findByRole('checkbox', { name: 'LinkedIn Jobs' });
  await userEvent.click(screen.getByRole('button', { name: /Publish job/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Choose where to publish this job',
  );
  expect(calls('/jobs/job-1/publish')).toEqual([]);
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Only in HireAI' }),
  );
  await userEvent.click(screen.getByRole('button', { name: /Publish job/ }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(undefined));
  expect(calls('/jobs/job-1/publish')).toEqual([null]);
  expect(calls('/jobs/job-1/channels')).toEqual([]);
});

it('summarizes each channel and explains a failed request', () => {
  const { rerender } = render(
    <ChannelResults
      title="Senior PHP Developer"
      outcome={{
        results: [
          {
            channel: 'careers_website',
            label: 'Careers website',
            status: 'PUBLISHED',
            url: 'https://careers.example.com/jobs/42',
            message: 'Sent to your careers website.',
          },
          {
            channel: 'job_listing',
            label: 'LinkedIn Jobs',
            status: 'FAILED',
            url: null,
            message: 'LinkedIn rejected the job (HTTP 422).',
          },
        ],
      }}
    />,
  );
  const results = screen.getByRole('region', { name: 'Publishing results' });
  expect(within(results).getByText('Posted')).toBeVisible();
  expect(within(results).getByText('Failed')).toBeVisible();
  expect(
    within(results).getByText('LinkedIn rejected the job (HTTP 422).'),
  ).toBeVisible();
  expect(within(results).getByRole('link', { name: /View/ })).toHaveAttribute(
    'href',
    'https://careers.example.com/jobs/42',
  );
  rerender(
    <ChannelResults
      title="Senior PHP Developer"
      outcome={{ error: 'Too many requests.' }}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'couldn’t be posted to the other channels: Too many requests.',
  );
});
