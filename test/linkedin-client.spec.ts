import {
  jobTask,
  sendLinkedIn,
} from '../src/modules/organization-integrations/linkedin-client';
afterEach(() => jest.restoreAllMocks());
it('uses a batch request for Jobs and retains the asynchronous task receipt', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
    Response.json({
      elements: [{ status: 201, id: 'urn:li:simpleJobPostingTask:abc-123' }],
    }),
  );
  expect(
    await sendLinkedIn('token', 'job_listing', { title: 'Engineer' }),
  ).toEqual({
    status: 'SUBMITTED',
    remoteId: 'urn:li:simpleJobPostingTask:abc-123',
    errorCode: null,
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.linkedin.com/rest/simpleJobPostings');
  expect(init?.headers).toMatchObject({
    'X-Restli-Method': 'batch_create',
    Authorization: 'Bearer token',
  });
  expect(JSON.parse(init!.body as string)).toEqual({
    elements: [{ title: 'Engineer' }],
  });
});
it('requires a receipt for a social post and never treats a server error as safe to retry', async () => {
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(null, { status: 201 }));
  expect((await sendLinkedIn('token', 'company_announcement', {})).status).toBe(
    'UNKNOWN',
  );
  fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  expect((await sendLinkedIn('token', 'company_announcement', {})).status).toBe(
    'UNKNOWN',
  );
  fetcher.mockResolvedValue(
    new Response(null, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:123' },
    }),
  );
  expect((await sendLinkedIn('token', 'company_announcement', {})).status).toBe(
    'PUBLISHED',
  );
});
it('encodes the full task URN and distinguishes migration processing from a live listing', async () => {
  const id = 'urn:li:simpleJobPostingTask:abc-123';
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      Response.json({ results: { [id]: { status: 'PROCESSED' } } }),
    );
  expect((await jobTask('token', id)).status).toBe('PROCESSED');
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://api.linkedin.com/rest/simpleJobPostingTasks?ids=' +
      encodeURIComponent(id),
  );
  fetcher.mockResolvedValue(
    Response.json({
      results: {
        [id]: { status: 'SUCCEEDED', jobPosting: 'urn:li:jobPosting:123' },
      },
    }),
  );
  expect(await jobTask('token', id)).toEqual({
    status: 'PUBLISHED',
    url: 'https://www.linkedin.com/jobs/view/123',
  });
  fetcher.mockResolvedValue(
    Response.json({
      results: {
        [id + '-1']: { status: 'SUCCEEDED' },
        [id + '-2']: { status: 'PROCESSED', errorMessage: 'Invalid payload' },
      },
    }),
  );
  expect((await jobTask('token', id)).status).toBe('FAILED');
});
