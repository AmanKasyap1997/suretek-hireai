import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CareersPosting,
  publishCareersJob,
} from '../src/modules/organization-integrations/careers-client';
import {
  jobChannelsSchema,
  removableChannelSchema,
} from '../src/modules/organization-integrations/job-publishing.schemas';
import { JobPublishingService } from '../src/modules/organization-integrations/job-publishing.service';
import * as config from '../src/platform/config';
import { LinkedInService } from '../src/modules/organization-integrations/linkedin.service';
import { encryptSecret } from '../src/modules/super-admin/secrets';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';

const publishUrl = 'https://cms.example.com/hireai/jobs';
const posting: CareersPosting = {
  event: 'job.published',
  externalId: 'org:job',
  organization: 'test-org',
  job: {
    id: 'job',
    title: 'Senior PHP Developer',
    description: 'Build and maintain Laravel services.',
    department: 'Engineering',
    location: 'Noida',
    employmentType: 'FULL_TIME',
    openings: 2,
    salary: { min: 1200000, max: 1800000, currency: 'INR' },
    publishedAt: '2026-11-20T09:30:00.000Z',
  },
};
const env = [
  'INTEGRATION_CAREERS_CMS_PUBLISH_URL',
  'INTEGRATION_CAREERS_CMS_API_KEY_HEADER',
  'INTEGRATION_CAREERS_CMS_TOKEN_URL',
  'LINKEDIN_JOBS_APPROVED',
];
afterEach(() => {
  jest.restoreAllMocks();
  for (const name of env) delete process.env[name];
});

describe('careers website client', () => {
  beforeEach(() => {
    process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL = publishUrl;
  });

  it('upserts the job at the operator endpoint with the organization key', async () => {
    process.env.INTEGRATION_CAREERS_CMS_API_KEY_HEADER = 'X-CMS-Key';
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ id: 42, url: 'https://careers.example.com/jobs/42' }),
      );
    const result = await publishCareersJob(
      'api_key',
      { apiKey: 'cms-secret' },
      posting,
    );
    expect(result).toMatchObject({
      status: 'PUBLISHED',
      remoteId: '42',
      remoteUrl: 'https://careers.example.com/jobs/42',
      errorCode: null,
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(publishUrl);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      'X-CMS-Key': 'cms-secret',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'org:job',
    });
    expect(JSON.parse(init.body as string)).toEqual(posting);
  });

  it('accepts an empty receipt and ignores non-HTTPS job links', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ url: 'http://careers.example.com/jobs/1' }),
      );
    expect(
      await publishCareersJob('bearer', { accessToken: 'token' }, posting),
    ).toMatchObject({ status: 'PUBLISHED', remoteId: null, remoteUrl: null });
    expect(
      await publishCareersJob('bearer', { accessToken: 'token' }, posting),
    ).toMatchObject({ status: 'PUBLISHED', remoteUrl: null });
  });

  it('separates rejected jobs from unconfirmed deliveries', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('bad', { status: 422 }))
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockRejectedValueOnce(new Error('socket hang up'));
    const send = () =>
      publishCareersJob('bearer', { accessToken: 'token' }, posting);
    expect(await send()).toMatchObject({
      status: 'FAILED',
      errorCode: 'CAREERS_HTTP_422',
    });
    expect(await send()).toMatchObject({
      status: 'UNKNOWN',
      errorCode: 'CAREERS_HTTP_503',
    });
    expect(await send()).toMatchObject({
      status: 'UNKNOWN',
      errorCode: 'DELIVERY_UNCONFIRMED',
    });
  });

  it('exchanges client credentials for a token before posting', async () => {
    process.env.INTEGRATION_CAREERS_CMS_TOKEN_URL =
      'https://cms.example.com/oauth/token';
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ access_token: 'cms-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(Response.json({ id: 'a1' }));
    const result = await publishCareersJob(
      'oauth_client_credentials',
      { clientId: 'client', clientSecret: 'client-secret' },
      posting,
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://cms.example.com/oauth/token',
    );
    expect((fetcher.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer cms-token',
    });
    expect(result.credentials.accessToken).toBe('cms-token');
  });

  it('does not post when the token exchange fails', async () => {
    process.env.INTEGRATION_CAREERS_CMS_TOKEN_URL =
      'https://cms.example.com/oauth/token';
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ error: 'invalid_client' }, { status: 401 }),
      );
    expect(
      await publishCareersJob(
        'oauth_client_credentials',
        { clientId: 'client', clientSecret: 'client-secret' },
        posting,
      ),
    ).toMatchObject({ status: 'FAILED', errorCode: 'CAREERS_AUTH_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires an operator-configured HTTPS endpoint', async () => {
    delete process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL;
    await expect(
      publishCareersJob('bearer', { accessToken: 'token' }, posting),
    ).rejects.toThrow('operator must configure');
    process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL = 'http://cms.example.com';
    await expect(
      publishCareersJob('bearer', { accessToken: 'token' }, posting),
    ).rejects.toThrow('trusted HTTPS');
  });
});

describe('job channel publishing', () => {
  const actor = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: Role.HR_ADMIN,
  };
  const jobId = '33333333-3333-4333-8333-333333333333';
  const pageUrn = 'urn:li:organization:123';
  const careersUrl = 'https://careers.example.com/jobs/42';
  type Row = Record<string, unknown>;
  let connections: Row[];
  let job: Row | null;
  let careersCurrent: Row | null;
  let linkedinExisting: Record<string, Row | null>;
  let audits: unknown[][];
  let writes: { sql: string; params: unknown[] }[];
  let historyRows: Row[];

  const connection = (
    provider: string,
    environment = 'production',
    method = 'api_key',
  ) => ({
    id: `conn-${provider}`,
    provider,
    environment,
    method,
    version: '2026-11-20 09:00:00+00',
    encrypted_credentials: encryptSecret(
      JSON.stringify({ apiKey: provider + '-key' }),
      ['organization', actor.tenantId, provider, environment].join(':'),
    ),
  });

  const setup = () => {
    audits = [];
    writes = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('audit_events')) audits.push(params);
        else if (sql.startsWith('UPDATE')) writes.push({ sql, params });
        else if (sql.includes('FROM integration_configs')) return connections;
        else if (sql.includes('DISTINCT ON (channel)')) return historyRows;
        return [];
      }),
      one: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM tenants'))
          return {
            is_platform: false,
            status: 'active',
            deleted_at: null,
            enabled_modules: ['hiring'],
            slug: 'test-org',
          };
        if (sql.includes('FROM jobs')) return job;
        if (sql.includes('FOR UPDATE')) return careersCurrent;
        if (sql.startsWith('INSERT INTO integration_publications'))
          return { id: 'pub-careers' };
        if (sql.startsWith('UPDATE integration_publications')) {
          writes.push({ sql, params });
          return { id: params[1] };
        }
        if (sql.includes('LIMIT 1'))
          return linkedinExisting[params[2] as string];
        if (sql.includes('AND id=$2'))
          return {
            status: 'PUBLISHED',
            remote_url: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
            error_code: null,
          };
        return null;
      }),
    };
    const db = {
      ...client,
      transaction: jest.fn(async (fn: (tx: typeof client) => unknown) =>
        fn(client),
      ),
    };
    const linkedin = {
      preview: jest.fn(async (_actor: unknown, input: { channel: string }) => ({
        id: `preview-${input.channel}`,
      })),
      publish: jest.fn(async (_actor: unknown, id: string) => ({
        id,
        status: 'PUBLISHED',
      })),
      removePost: jest.fn(async () => ({ id: 'pub-1', status: 'REMOVED' })),
    };
    return {
      db,
      linkedin,
      service: new JobPublishingService(
        db as unknown as DbService,
        linkedin as unknown as LinkedInService,
      ),
    };
  };

  beforeAll(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });
  beforeEach(() => {
    connections = [];
    job = {
      id: jobId,
      title: 'Senior PHP Developer',
      description: 'Build and maintain Laravel services.',
      department: 'Engineering',
      location: 'Noida',
      employment_type: 'FULL_TIME',
      openings: 2,
      salary_min: '1200000.00',
      salary_max: null,
      status: 'PUBLISHED',
      updated_at: new Date('2026-11-20T09:30:00Z'),
    };
    careersCurrent = null;
    linkedinExisting = {};
    historyRows = [];
  });

  it('lists enabled channels and explains what still blocks them', async () => {
    connections = [
      connection('careers_cms', 'sandbox'),
      connection('linkedin', 'sandbox'),
      connection('linkedin_jobs'),
    ];
    const { service } = setup();
    const channels = await service.channels(actor);
    expect(channels.map((c) => [c.channel, c.ready])).toEqual([
      ['careers_website', false],
      ['company_announcement', false],
      ['job_listing', false],
    ]);
    expect(channels[0].reason).toContain('INTEGRATION_CAREERS_CMS_PUBLISH_URL');
    expect(channels[1].reason).toContain('production');
    expect(channels[2].reason).toContain('partner access');
    expect(JSON.stringify(channels)).not.toContain('careers_cms-key');

    process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL = publishUrl;
    process.env.LINKEDIN_JOBS_APPROVED = 'true';
    connections = [
      connection('careers_cms', 'sandbox'),
      connection('linkedin_jobs'),
    ];
    expect(await service.channels(actor)).toEqual([
      {
        channel: 'careers_website',
        label: 'Careers website',
        environment: 'sandbox',
        ready: true,
        reason: null,
      },
      {
        channel: 'job_listing',
        label: 'LinkedIn Jobs',
        environment: 'production',
        ready: true,
        reason: null,
      },
    ]);
  });

  it('is for HR Admins and recruiters, who publish approved jobs', async () => {
    const { service } = setup();
    await expect(
      service.channels({ ...actor, role: Role.RECRUITER }),
    ).resolves.toEqual(expect.any(Array));
    await expect(
      service.channels({ ...actor, role: Role.HIRING_MANAGER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('posts to the careers website first and reuses its link for LinkedIn', async () => {
    process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL = publishUrl;
    process.env.LINKEDIN_JOBS_APPROVED = 'true';
    connections = [
      connection('careers_cms'),
      connection('linkedin'),
      connection('linkedin_jobs'),
    ];
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ id: 42, url: careersUrl }));
    const { service, linkedin } = setup();
    const { results } = await service.publish(
      actor,
      jobId,
      jobChannelsSchema.parse({
        channels: ['job_listing', 'company_announcement', 'careers_website'],
        pageUrn,
        commentary: 'We are hiring!',
        confirmed: true,
      }),
    );
    expect(results.map((r) => [r.channel, r.status])).toEqual([
      ['careers_website', 'PUBLISHED'],
      ['company_announcement', 'PUBLISHED'],
      ['job_listing', 'PUBLISHED'],
    ]);
    expect(results[0].url).toBe(careersUrl);
    const sent = JSON.parse(
      (fetcher.mock.calls[0][1] as RequestInit).body as string,
    ) as CareersPosting;
    expect(sent).toMatchObject({
      externalId: `${actor.tenantId}:${jobId}`,
      organization: 'test-org',
      job: {
        title: 'Senior PHP Developer',
        salary: { min: 1200000, max: null, currency: 'INR' },
        publishedAt: '2026-11-20T09:30:00.000Z',
      },
    });
    expect(linkedin.preview).toHaveBeenNthCalledWith(1, actor, {
      jobId,
      channel: 'company_announcement',
      applicationUrl: careersUrl,
      pageUrn,
      pageStart: 0,
      commentary: 'We are hiring!',
    });
    expect(linkedin.preview).toHaveBeenNthCalledWith(
      2,
      actor,
      expect.objectContaining({
        channel: 'job_listing',
        applicationUrl: careersUrl,
        pageUrn: undefined,
      }),
    );
    expect(linkedin.publish).toHaveBeenCalledWith(
      actor,
      'preview-company_announcement',
    );
    const recorded = writes.find((w) =>
      w.sql.includes('SET status=$3,remote_id=$4'),
    );
    expect(recorded?.params).toEqual([
      actor.tenantId,
      'pub-careers',
      'PUBLISHED',
      '42',
      careersUrl,
      null,
    ]);
    expect(audits.map((a) => a[2])).toEqual([
      'integration.publication_requested',
      'integration.publication_result',
    ]);
  });

  it('only posts jobs that are published in HireAI', async () => {
    job = { ...job, status: 'APPROVED' };
    const { service } = setup();
    await expect(
      service.publish(
        actor,
        jobId,
        jobChannelsSchema.parse({
          channels: ['careers_website'],
          confirmed: true,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never posts a job to LinkedIn twice and needs an application link', async () => {
    process.env.LINKEDIN_JOBS_APPROVED = 'true';
    connections = [connection('linkedin'), connection('linkedin_jobs')];
    linkedinExisting.company_announcement = {
      status: 'PUBLISHED',
      remote_url: 'https://www.linkedin.com/feed/update/urn:li:share:9/',
      error_code: null,
    };
    const { service, linkedin } = setup();
    const { results } = await service.publish(
      actor,
      jobId,
      jobChannelsSchema.parse({
        channels: ['company_announcement', 'job_listing'],
        pageUrn,
        confirmed: true,
      }),
    );
    expect(results[0]).toMatchObject({
      status: 'PUBLISHED',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:9/',
      message: expect.stringContaining('Already sent'),
    });
    expect(results[1]).toMatchObject({
      status: 'FAILED',
      message: expect.stringContaining('application page URL'),
    });
    expect(linkedin.preview).not.toHaveBeenCalled();
  });

  it('reports channels that are not enabled without failing the others', async () => {
    connections = [connection('linkedin')];
    const { service, linkedin } = setup();
    linkedin.preview.mockRejectedValueOnce(
      new ForbiddenException('Company-page access was revoked'),
    );
    const { results } = await service.publish(
      actor,
      jobId,
      jobChannelsSchema.parse({
        channels: ['careers_website', 'company_announcement'],
        pageUrn,
        applicationUrl: 'https://example.com/apply',
        confirmed: true,
      }),
    );
    expect(results).toEqual([
      expect.objectContaining({
        channel: 'careers_website',
        status: 'FAILED',
        message: expect.stringContaining('isn’t enabled'),
      }),
      expect.objectContaining({
        channel: 'company_announcement',
        status: 'FAILED',
        message: 'Company-page access was revoked',
      }),
    ]);
  });

  it('keeps a live careers post and safely resends an unconfirmed one', async () => {
    process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL = publishUrl;
    connections = [connection('careers_cms')];
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ url: careersUrl }));
    const input = jobChannelsSchema.parse({
      channels: ['careers_website'],
      confirmed: true,
    });
    careersCurrent = {
      id: 'pub-old',
      status: 'PUBLISHED',
      remote_url: careersUrl,
      error_code: null,
      fresh: false,
    };
    const { service } = setup();
    expect(
      (await service.publish(actor, jobId, input)).results[0],
    ).toMatchObject({
      status: 'PUBLISHED',
      url: careersUrl,
      message: expect.stringContaining('Already'),
    });
    expect(fetcher).not.toHaveBeenCalled();

    careersCurrent = { ...careersCurrent, status: 'UNKNOWN', remote_url: null };
    expect(
      (await service.publish(actor, jobId, input)).results[0],
    ).toMatchObject({ status: 'PUBLISHED', url: careersUrl });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(writes[0].sql).toContain("SET status='SENDING'");
    expect(writes[0].params[1]).toBe('pub-old');
  });

  it('posts on a LinkedIn profile only for the admin who connected it', async () => {
    const applicationUrl = 'https://example.com/apply';
    connections = [
      { ...connection('linkedin_profile'), updated_by: 'another-admin' },
    ];
    const { service, linkedin } = setup();
    const [channel] = await service.channels(actor);
    expect(channel).toMatchObject({
      channel: 'profile_post',
      label: 'LinkedIn profile post',
      ready: false,
    });
    expect(channel.reason).toContain(
      'the person who connected it, so only they can use it',
    );
    const input = jobChannelsSchema.parse({
      channels: ['profile_post'],
      applicationUrl,
      commentary: 'Join our team',
      visibility: 'CONNECTIONS',
      confirmed: true,
    });
    expect(
      (await service.publish(actor, jobId, input)).results[0],
    ).toMatchObject({ status: 'FAILED', message: channel.reason });
    expect(linkedin.preview).not.toHaveBeenCalled();

    connections = [
      { ...connection('linkedin_profile'), updated_by: actor.userId },
    ];
    expect((await service.channels(actor))[0].ready).toBe(true);
    expect(
      (await service.publish(actor, jobId, input)).results[0],
    ).toMatchObject({ channel: 'profile_post', status: 'PUBLISHED' });
    expect(linkedin.preview).toHaveBeenCalledWith(actor, {
      jobId,
      channel: 'profile_post',
      applicationUrl,
      pageUrn: undefined,
      pageStart: 0,
      commentary: 'Join our team',
      visibility: 'CONNECTIONS',
    });
    expect(linkedin.publish).toHaveBeenCalledWith(
      actor,
      'preview-profile_post',
    );
  });

  it('removes a LinkedIn post so the job can be posted again', async () => {
    const { service, linkedin } = setup();
    expect(await service.remove(actor, jobId, 'profile_post')).toEqual({
      channel: 'profile_post',
      label: 'LinkedIn profile post',
      status: 'REMOVED',
      url: null,
      message: 'Removed from LinkedIn. You can post it again.',
    });
    expect(linkedin.removePost).toHaveBeenCalledWith(
      actor,
      jobId,
      'profile_post',
    );
    await expect(
      service.remove(
        { ...actor, role: Role.RECRUITER },
        jobId,
        'company_announcement',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(linkedin.removePost).toHaveBeenCalledTimes(1);
    // Only feed posts can be deleted; listings and website jobs can't.
    expect(removableChannelSchema.safeParse('job_listing').success).toBe(false);
    expect(removableChannelSchema.safeParse('careers_website').success).toBe(
      false,
    );
  });

  it('explains removed posts and LinkedIn’s duplicate-post rule', async () => {
    historyRows = [
      {
        channel: 'profile_post',
        status: 'REMOVED',
        remote_url: null,
        error_code: null,
        updated_at: '2026-11-23 10:00:00+00',
      },
      {
        channel: 'company_announcement',
        status: 'FAILED',
        remote_url: null,
        error_code: 'LINKEDIN_HTTP_422',
        updated_at: '2026-11-23 10:00:00+00',
      },
    ];
    const history = await setup().service.history(actor, jobId);
    expect(history[0]).toMatchObject({
      status: 'REMOVED',
      message: 'Removed from LinkedIn. You can post it again.',
    });
    expect(history[1].message).toContain('change the post text or wait');
  });

  it('defaults profile posts to public and allows connections only', () => {
    const parse = (visibility?: string) =>
      jobChannelsSchema.safeParse({
        channels: ['profile_post'],
        applicationUrl: 'https://example.com/apply',
        visibility,
        confirmed: true,
      });
    expect(parse().data?.visibility).toBe('PUBLIC');
    expect(parse('CONNECTIONS').data?.visibility).toBe('CONNECTIONS');
    expect(parse('ONLY_ME').success).toBe(false);
  });

  it('takes HireAI’s localhost apply page for test posts, never in production', () => {
    const post = (applicationUrl: string) =>
      jobChannelsSchema.safeParse({
        channels: ['profile_post'],
        applicationUrl,
        confirmed: true,
      }).success;
    const local = 'http://localhost:5173/console/careers/acme/jobs/1';
    expect(post(local)).toBe(true);
    expect(post('http://127.0.0.1:5173/console/careers/acme/jobs/1')).toBe(
      true,
    );
    expect(post('http://careers.example.com/jobs/1')).toBe(false);
    const real = config.readConfig();
    jest
      .spyOn(config, 'readConfig')
      .mockReturnValue({ ...real, NODE_ENV: 'production' });
    expect(post(local)).toBe(false);
    expect(post('https://careers.example.com/jobs/1')).toBe(true);
    jest.restoreAllMocks();
  });

  it('requires confirmation and a company page for LinkedIn posts', () => {
    expect(
      jobChannelsSchema.safeParse({ channels: ['careers_website'] }).success,
    ).toBe(false);
    expect(
      jobChannelsSchema.safeParse({
        channels: ['company_announcement'],
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      jobChannelsSchema.safeParse({
        channels: ['job_listing'],
        applicationUrl: 'http://example.com/apply',
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      jobChannelsSchema.safeParse({
        channels: ['careers_website', 'careers_website'],
        confirmed: true,
      }).success,
    ).toBe(false);
  });
});
