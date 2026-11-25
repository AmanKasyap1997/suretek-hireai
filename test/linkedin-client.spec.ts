import {
  deleteLinkedInPost,
  jobTask,
  linkedinMember,
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
it('posts on a member profile through the UGC API and keeps the receipt', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(null, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:77' },
    }),
  );
  const body = { author: 'urn:li:person:member-1' };
  expect(await sendLinkedIn('member-token', 'profile_post', body)).toEqual({
    status: 'PUBLISHED',
    remoteId: 'urn:li:share:77',
    errorCode: null,
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.linkedin.com/v2/ugcPosts');
  expect(init?.headers).toEqual({
    Authorization: 'Bearer member-token',
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  });
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(init!.body as string)).toEqual(body);
  fetcher.mockResolvedValue(new Response(null, { status: 403 }));
  expect(await sendLinkedIn('member-token', 'profile_post', body)).toEqual({
    status: 'FAILED',
    remoteId: null,
    errorCode: 'LINKEDIN_HTTP_403',
  });
});
it('reads the signed-in member and rejects unusable member IDs', async () => {
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ sub: 'Ab3_x-9', name: 'Test Member' }),
    );
  expect(await linkedinMember('member-token')).toEqual({
    id: 'Ab3_x-9',
    name: 'Test Member',
  });
  expect(fetcher.mock.calls[0][0]).toBe('https://api.linkedin.com/v2/userinfo');
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({
    Authorization: 'Bearer member-token',
  });
  fetcher.mockResolvedValueOnce(Response.json({ sub: 'urn:li:person:1' }));
  await expect(linkedinMember('member-token')).rejects.toThrow('member ID');
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(linkedinMember('member-token')).rejects.toThrow('Reconnect');
});
it('deletes profile posts through the UGC API and company posts through Posts', async () => {
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }));
  expect(
    await deleteLinkedInPost(
      'member-token',
      'profile_post',
      'urn:li:share:7001',
    ),
  ).toBe(204);
  let [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(
    'https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A7001',
  );
  expect(init?.method).toBe('DELETE');
  expect(init?.headers).toEqual({
    Authorization: 'Bearer member-token',
    'X-Restli-Protocol-Version': '2.0.0',
  });
  expect(init?.redirect).toBe('error');

  fetcher.mockResolvedValue(new Response(null, { status: 403 }));
  expect(
    await deleteLinkedInPost(
      'page-token',
      'company_announcement',
      'urn:li:ugcPost:7002',
    ),
  ).toBe(403);
  [url, init] = fetcher.mock.calls[1];
  expect(url).toBe(
    'https://api.linkedin.com/rest/posts/urn%3Ali%3AugcPost%3A7002',
  );
  expect(init?.headers).toMatchObject({
    Authorization: 'Bearer page-token',
    'X-Restli-Protocol-Version': '2.0.0',
    'X-RestLi-Method': 'DELETE',
  });
  expect((init?.headers as Record<string, string>)['LinkedIn-Version']).toMatch(
    /^20\d{4}$/,
  );

  // Only post IDs LinkedIn returned are ever sent back to it.
  await expect(
    deleteLinkedInPost('member-token', 'profile_post', 'urn:li:share:1/../x'),
  ).rejects.toThrow('Invalid LinkedIn post ID');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
