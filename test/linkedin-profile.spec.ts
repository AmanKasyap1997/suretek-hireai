import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LinkedInService } from '../src/modules/organization-integrations/linkedin.service';
import * as linkedinClient from '../src/modules/organization-integrations/linkedin-client';
import { encryptSecret } from '../src/modules/super-admin/secrets';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';

describe('LinkedIn profile posts', () => {
  const actor = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: Role.HR_ADMIN,
  };
  const jobId = '33333333-3333-4333-8333-333333333333';
  const applicationUrl = 'https://careers.example.com/jobs/42';
  let connector: string;
  let credentials: Record<string, string>;
  let inserted: unknown[] | null;
  let post: Record<string, unknown> | null;
  let removed: unknown[] | null;
  let audited: unknown[][];

  const setup = () => {
    inserted = null;
    removed = null;
    audited = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('audit_events')) audited.push(params);
        return [];
      }),
      one: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT id,remote_id,payload')) return post;
        if (sql.includes("SET status='REMOVED'")) {
          removed = params;
          return { id: params[1] };
        }
        if (sql.includes('enabled_modules FROM tenants'))
          return {
            is_platform: false,
            status: 'active',
            deleted_at: null,
            enabled_modules: ['hiring'],
          };
        if (sql.includes('FROM integration_providers')) return { revision: 1 };
        if (sql.includes('FROM integration_configs'))
          return {
            id: 'conn-profile',
            provider_revision: 1,
            version: '2026-11-23 09:00:00+00',
            updated_by: connector,
            encrypted_credentials: encryptSecret(
              JSON.stringify(credentials),
              [
                'organization',
                actor.tenantId,
                // The provider asked for: the profile, or the company page.
                String(params[1] ?? 'linkedin_profile'),
                'production',
              ].join(':'),
            ),
          };
        if (sql.includes('FROM jobs'))
          return {
            id: jobId,
            title: 'Senior PHP Developer',
            description: 'Build and maintain Laravel services.',
            location: 'Noida',
            created_at: new Date('2026-11-20T09:00:00Z'),
            updated_at: new Date('2026-11-20T09:30:00Z'),
            version: '2026-11-20 09:30:00+00',
          };
        if (sql.startsWith('INSERT INTO integration_publications')) {
          inserted = params;
          return { id: 'pub-profile' };
        }
        return null;
      }),
    };
    const db = {
      ...client,
      transaction: jest.fn(async (fn: (tx: typeof client) => unknown) =>
        fn(client),
      ),
    };
    return new LinkedInService(db as unknown as DbService);
  };

  beforeAll(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });
  beforeEach(() => {
    connector = actor.userId;
    credentials = {
      accessToken: 'member-token',
      expiresAt: String(Date.now() + 3600000),
      memberId: 'member-1',
    };
    post = {
      id: 'pub-profile',
      remote_id: 'urn:li:share:7001',
      payload: { request: { author: 'urn:li:person:member-1' } },
    };
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds a share of the job on the connected member’s profile', async () => {
    const fetcher = jest.spyOn(global, 'fetch');
    const preview = await setup().preview(actor, {
      jobId,
      channel: 'profile_post',
      applicationUrl,
      pageStart: 0,
      visibility: 'CONNECTIONS',
    });
    expect(preview.request).toEqual({
      author: 'urn:li:person:member-1',
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: 'We are hiring: Senior PHP Developer — Noida\n\nApply here: https://careers.example.com/jobs/42',
          },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: applicationUrl,
              title: { text: 'Senior PHP Developer' },
              description: { text: 'View this opportunity and apply.' },
            },
          ],
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'CONNECTIONS' },
    });
    expect(inserted?.[2]).toBe('conn-profile');
    expect(inserted?.[3]).toBe('profile_post');
    // The member ID saved by the connection test avoids an extra call.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('looks up the member when the connection predates the member ID', async () => {
    delete credentials.memberId;
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ sub: 'member-2', name: 'Test' }));
    const preview = await setup().preview(actor, {
      jobId,
      channel: 'profile_post',
      applicationUrl,
      pageStart: 0,
      commentary: 'Join our team',
    });
    expect(preview.request).toMatchObject({
      author: 'urn:li:person:member-2',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: 'Join our team\n\nApply here: https://careers.example.com/jobs/42',
          },
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    });
  });

  it('lets a recruiter post on the company page, not on someone’s profile', async () => {
    const recruiter = {
      ...actor,
      userId: '55555555-5555-4555-8555-555555555555',
      role: Role.RECRUITER,
    };
    const owns = jest.spyOn(linkedinClient, 'ownsPage').mockResolvedValue(true);
    const service = setup();
    await service.preview(recruiter, {
      jobId,
      channel: 'company_announcement',
      pageUrn: 'urn:li:organization:42',
      applicationUrl,
      pageStart: 0,
    });
    expect(owns).toHaveBeenCalled();
    expect(inserted).not.toBeNull();
    await expect(
      setup().preview(recruiter, {
        jobId,
        channel: 'profile_post',
        applicationUrl,
        pageStart: 0,
      }),
    ).rejects.toThrow(
      'This posts on the LinkedIn profile of the person who connected it, so only they can use it.',
    );
    // Deleting posts stays with HR Admins.
    await expect(
      setup().removePost(recruiter, jobId, 'company_announcement'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup().preview(
        { ...recruiter, role: Role.HIRING_MANAGER },
        {
          jobId,
          channel: 'company_announcement',
          pageUrn: 'urn:li:organization:42',
          applicationUrl,
          pageStart: 0,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never posts on another admin’s profile', async () => {
    connector = '44444444-4444-4444-8444-444444444444';
    await expect(
      setup().preview(actor, {
        jobId,
        channel: 'profile_post',
        applicationUrl,
        pageStart: 0,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inserted).toBeNull();
  });

  it('removes the post from LinkedIn and frees the channel', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(await setup().removePost(actor, jobId, 'profile_post')).toEqual({
      id: 'pub-profile',
      status: 'REMOVED',
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A7001',
    );
    expect(removed).toEqual([actor.tenantId, 'pub-profile']);
    expect(audited).toHaveLength(1);
  });

  it('treats a post already deleted on LinkedIn as removed', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      setup().removePost(actor, jobId, 'profile_post'),
    ).resolves.toMatchObject({ status: 'REMOVED' });
    expect(removed).not.toBeNull();
  });

  it('keeps the post listed when LinkedIn refuses to delete it', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 403 }));
    const attempt = setup().removePost(actor, jobId, 'profile_post');
    await expect(attempt).rejects.toBeInstanceOf(BadGatewayException);
    await expect(attempt).rejects.toThrow('remove it on LinkedIn directly');
    expect(removed).toBeNull();

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));
    await expect(
      setup().removePost(actor, jobId, 'profile_post'),
    ).rejects.toThrow('removing a post twice is safe');
    expect(removed).toBeNull();
  });

  it('removes only posts made by the connected account', async () => {
    const fetcher = jest.spyOn(global, 'fetch');
    connector = '44444444-4444-4444-8444-444444444444';
    await expect(
      setup().removePost(actor, jobId, 'profile_post'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    connector = actor.userId;
    credentials.memberId = 'someone-else';
    await expect(
      setup().removePost(actor, jobId, 'profile_post'),
    ).rejects.toBeInstanceOf(ConflictException);

    post = null;
    await expect(
      setup().removePost(actor, jobId, 'profile_post'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetcher).not.toHaveBeenCalled();
    expect(removed).toBeNull();
  });
});
