import {
  littleText,
  POST_TEXT_LIMIT,
  withApplyLink,
} from '../src/modules/organization-integrations/linkedin-client';
import { jobChannelsSchema } from '../src/modules/organization-integrations/job-publishing.schemas';
import { LinkedInService } from '../src/modules/organization-integrations/linkedin.service';
import { encryptSecret } from '../src/modules/super-admin/secrets';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';

describe('the apply link at the end of a post', () => {
  const url =
    'https://hireai.example.com/console/careers/acme/jobs/7?source=linkedin';

  it('ends the post with the link, once', () => {
    expect(withApplyLink('We are hiring', url)).toBe(
      `We are hiring\n\nApply here: ${url}`,
    );
    // Already in the text: not added again.
    expect(withApplyLink(`Apply: ${url}`, url)).toBe(`Apply: ${url}`);
  });

  it('shortens a long post so the link still fits', () => {
    const post = withApplyLink('word '.repeat(1000), url);
    expect(post.length).toBeLessThanOrEqual(POST_TEXT_LIMIT);
    expect(post.endsWith(`…\n\nApply here: ${url}`)).toBe(true);
  });

  it('escapes the link for company page posts', () => {
    const post = withApplyLink(
      'Join us',
      'https://example.com/apply_now',
      littleText,
    );
    expect(post).toBe('Join us\n\nApply here: https://example.com/apply\\_now');
  });
});

describe('LinkedIn post text', () => {
  it('escapes every character the Posts API reserves', () => {
    expect(
      littleText('Noida, INDIA ( Remote ) | 4*5 [x] {y} <z> @ \\ _ ~'),
    ).toBe(
      'Noida, INDIA \\( Remote \\) \\| 4\\*5 \\[x\\] \\{y\\} \\<z\\> \\@ \\\\ \\_ \\~',
    );
  });

  it('keeps hashtags that start a word and escapes other #', () => {
    expect(littleText('#hiring for C# and #php_dev roles, ticket #42')).toBe(
      '{hashtag|\\#|hiring} for C\\# and {hashtag|\\#|php\\_dev} roles, ticket \\#42',
    );
  });

  it('shortens text at a word so the encoded post fits', () => {
    const text = 'Build (Laravel) APIs. '.repeat(200);
    const encoded = littleText(text);
    expect(encoded.length).toBeLessThanOrEqual(POST_TEXT_LIMIT);
    expect(encoded.endsWith('…')).toBe(true);
    expect(encoded).not.toMatch(/\\$|\\…$/);
    expect(littleText('short')).toBe('short');
  });

  it('accepts post text up to LinkedIn’s 3,000-character limit', () => {
    const parse = (commentary: string) =>
      jobChannelsSchema.safeParse({
        channels: ['profile_post'],
        applicationUrl: 'https://example.com/apply',
        commentary,
        confirmed: true,
      }).success;
    expect(parse('a'.repeat(3000))).toBe(true);
    expect(parse('a'.repeat(3001))).toBe(false);
  });
});

describe('LinkedIn company page post', () => {
  const actor = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: Role.HR_ADMIN,
  };
  const jobId = '33333333-3333-4333-8333-333333333333';
  const pageUrn = 'urn:li:organization:123';

  beforeAll(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });
  afterEach(() => jest.restoreAllMocks());

  const service = () => {
    const client = {
      query: jest.fn(async () => []),
      one: jest.fn(async (sql: string) => {
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
            id: 'conn-page',
            provider_revision: 1,
            version: '2026-11-24 09:00:00+00',
            updated_by: actor.userId,
            encrypted_credentials: encryptSecret(
              JSON.stringify({
                accessToken: 'page-token',
                expiresAt: String(Date.now() + 3600000),
              }),
              ['organization', actor.tenantId, 'linkedin', 'production'].join(
                ':',
              ),
            ),
          };
        if (sql.includes('FROM jobs'))
          return {
            id: jobId,
            title: 'Full Stack Developer',
            description: 'Build web apps.',
            location: 'Noida, INDIA ( Remote )',
            created_at: new Date('2026-11-23T09:00:00Z'),
            updated_at: new Date('2026-11-23T09:30:00Z'),
            version: '2026-11-23 09:30:00+00',
          };
        if (sql.startsWith('INSERT INTO integration_publications'))
          return { id: 'pub-page' };
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

  it('sends post text in LinkedIn’s escaped format', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) =>
        String(input).includes('organizationAcls')
          ? Response.json({
              elements: [
                {
                  organization: pageUrn,
                  role: 'ADMINISTRATOR',
                  state: 'APPROVED',
                },
              ],
            })
          : Response.json({ localizedName: 'Suretek Infosoft' }),
      );
    const preview = (commentary?: string) =>
      service().preview(actor, {
        jobId,
        channel: 'company_announcement',
        applicationUrl: 'https://careers.example.com/jobs/42',
        pageUrn,
        pageStart: 0,
        commentary,
      });
    // The text, escaped, then the apply link for candidates.
    expect((await preview()).request.commentary).toBe(
      'We are hiring: Full Stack Developer — Noida, INDIA \\( Remote \\)\n\nApply here: https://careers.example.com/jobs/42',
    );
    expect((await preview('Join us (hybrid) #hiring')).request.commentary).toBe(
      'Join us \\(hybrid\\) {hashtag|\\#|hiring}\n\nApply here: https://careers.example.com/jobs/42',
    );
  });
});
