import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { LinkedInPublishing } from './LinkedInPublishing';
afterEach(() => vi.unstubAllGlobals());
it('requires preview and explicit approval before publishing a Jobs listing', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/jobs'))
      return Response.json([
        { id: 'job', title: 'Engineer', location: 'Delhi' },
      ]);
    if (url.endsWith('/preview'))
      return Response.json({
        id: 'preview',
        channel: 'job_listing',
        jobTitle: 'Engineer',
        request: {
          integrationContext: 'urn:li:organization:123',
          companyApplyUrl: 'https://example.com/jobs/1',
          description: 'Job description',
          location: 'Delhi',
        },
      });
    if (init.method === 'POST')
      return Response.json({ id: 'preview', status: 'SUBMITTED' });
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LinkedInPublishing />
    </QueryClientProvider>,
  );
  await userEvent.selectOptions(
    await screen.findByLabelText('Published job'),
    'job',
  );
  expect(screen.queryByLabelText('Publish as')).not.toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText('Application page URL'),
    'https://example.com/jobs/1',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Preview LinkedIn Jobs listing' }),
  );
  const publish = await screen.findByRole('button', {
    name: 'Publish LinkedIn Jobs listing',
  });
  expect(publish).toBeDisabled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/publish'))).toBe(
    false,
  );
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(publish);
  expect(
    await screen.findByText('Publication status: SUBMITTED'),
  ).toBeVisible();
  const call = fetcher.mock.calls.find(([url]) => url.endsWith('/publish'))!;
  expect(JSON.parse(call[1].body as string)).toEqual({ confirmed: true });
});
