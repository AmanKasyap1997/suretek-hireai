import { JwtService } from '@nestjs/jwt';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { useApiFixture } from '../helpers/api-fixtures';
import { Role } from '../../src/shared/enums';
import {
  encryptSecret,
  decryptSecret,
} from '../../src/modules/super-admin/secrets';
import * as linkedin from '../../src/modules/organization-integrations/linkedin-client';

describe('LinkedIn Jobs publishing', () => {
  const f = useApiFixture();
  describe('partner-approved Jobs flow', () => {
    let platformId: string, platformToken: string, jobId: string;
    const base = '/organization/integrations/linkedin';
    beforeAll(async () => {
      Object.assign(process.env, {
        INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
        PUBLIC_WEB_BASE_URL: 'http://localhost:5173',
        LINKEDIN_JOBS_APPROVED: 'true',
      });
      platformId = randomUUID();
      await f.pool.query(
        "INSERT INTO tenants(id,name,is_platform) VALUES($1,'LinkedIn platform',true)",
        [platformId],
      );
      const owner = await f.user(platformId, Role.SUPER_ADMIN);
      platformToken = await f.app!.get(JwtService).signAsync(
        { sub: owner.id, tenantId: platformId },
        {
          expiresIn: 900,
          algorithm: 'HS256',
          issuer: 'suretek-hireai',
          audience: 'suretek-api',
        },
      );
      await f.pool.query(
        "INSERT INTO platform_organizations(tenant_id,organization_id,name,slug) VALUES($1,$2,'Test org',$3)",
        [platformId, f.tenantA, 'linkedin-' + randomUUID()],
      );
      await f.pool.query(
        'INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES($1,$2,true,$3)',
        ['linkedin_jobs', platformId, owner.id],
      );
      jobId = randomUUID();
      await f.pool.query(
        "INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by) VALUES($1,$2,'Software engineer',$3,'Engineering','Delhi, India','PUBLISHED',$4)",
        [
          jobId,
          f.tenantA,
          'Build useful recruitment software & tools with our engineering team. Own reliable services and collaborate with product designers and engineers.',
          f.adminA.id,
        ],
      );
    });
    beforeEach(() => {
      f.app!
        .get<ThrottlerStorageService>(getStorageToken())
        .onApplicationShutdown();
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      await f.pool.query(
        'DELETE FROM integration_providers WHERE tenant_id=$1',
        [platformId],
      );
      await f.pool.query(
        'DELETE FROM platform_organizations WHERE tenant_id=$1',
        [platformId],
      );
      await f.pool.query('DELETE FROM audit_events WHERE tenant_id=$1', [
        platformId,
      ]);
      await f.pool.query('DELETE FROM users WHERE tenant_id=$1', [platformId]);
      await f.pool.query('DELETE FROM tenants WHERE id=$1', [platformId]);
      for (const key of [
        'INTEGRATION_ENCRYPTION_KEY',
        'PUBLIC_WEB_BASE_URL',
        'LINKEDIN_JOBS_APPROVED',
      ])
        delete process.env[key];
    });
    const req = (method: 'get' | 'post', path: string) =>
      f.authorized(method, base + path);

    it('removes Company Pages authorization and announcement endpoints', async () => {
      const providers = await f
        .authorized('get', '/organization/integrations/providers')
        .expect(200);
      expect(
        providers.body.some(
          (provider: { provider: string }) => provider.provider === 'linkedin',
        ),
      ).toBe(false);
      await f
        .authorized('post', '/organization/integrations/oauth/start')
        .send({
          provider: 'linkedin',
          environment: 'sandbox',
          method: 'oauth2',
          credentials: {},
        })
        .expect(400);
      await req('get', '/pages').expect(404);
      await req('post', '/preview')
        .send({
          jobId,
          channel: 'company_announcement',
          applicationUrl: 'https://careers.example.test/job',
        })
        .expect(400);
    });

    it('onboards Jobs credentials, submits listings and polls publication status', async () => {
      const setupBody = {
        environment: 'production',
        companyUrn: 'urn:li:organization:123',
        clientId: 'partner-customer-id',
        clientSecret: 'partner-customer-secret',
      };
      const setupPath =
        '/super-admin/integration-providers/linkedin-jobs/organizations/' +
        f.tenantA;
      await f.authorized('post', setupPath).send(setupBody).expect(403);
      const setup = await f
        .authorized('post', setupPath, platformToken)
        .send(setupBody)
        .expect(201);
      await f
        .authorized('post', '/organization/integrations')
        .send({
          provider: 'linkedin_jobs',
          environment: 'sandbox',
          method: 'oauth_client_credentials',
          credentials: { clientId: 'x', clientSecret: 'secret-123' },
        })
        .expect(403);
      const credentials = {
        ...setupBody,
        accessToken: 'partner-token',
        expiresAt: String(Date.now() + 3600000),
      };
      await f.pool.query(
        "UPDATE integration_configs SET status='enabled',encrypted_credentials=$2 WHERE id=$1",
        [
          setup.body.id,
          encryptSecret(
            JSON.stringify(credentials),
            `organization:${f.tenantA}:linkedin_jobs:production`,
          ),
        ],
      );
      const preview = await req('post', '/preview')
        .send({
          jobId,
          channel: 'job_listing',
          applicationUrl: 'https://careers.example.test/job',
        })
        .expect(201);
      expect(preview.body.request).toMatchObject({
        integrationContext: setupBody.companyUrn,
        companyApplyUrl: 'https://careers.example.test/job',
        listingType: 'BASIC',
        jobPostingOperationType: 'CREATE',
        externalJobPostingId: f.tenantA + ':' + jobId,
      });
      expect(preview.body.request.description).toContain('&amp;');

      jest.spyOn(linkedin, 'sendLinkedIn').mockResolvedValue({
        status: 'SUBMITTED',
        remoteId: 'urn:li:simpleJobPostingTask:abc',
        errorCode: null,
      });
      expect(
        (
          await req('post', '/publications/' + preview.body.id + '/publish')
            .send({ confirmed: true })
            .expect(201)
        ).body.status,
      ).toBe('SUBMITTED');
      const poll = jest
        .spyOn(linkedin, 'jobTask')
        .mockResolvedValue({ status: 'PROCESSED', url: null });
      expect(
        (
          await req(
            'post',
            '/publications/' + preview.body.id + '/refresh',
          ).expect(201)
        ).body.status,
      ).toBe('PROCESSED');
      expect(poll).toHaveBeenCalledTimes(1);
      expect(
        (await req('get', '/publications').expect(200)).body,
      ).toMatchObject([
        { id: preview.body.id, channel: 'job_listing', status: 'PROCESSED' },
      ]);
      const stored = await f.pool.query(
        'SELECT encrypted_credentials FROM integration_configs WHERE id=$1',
        [setup.body.id],
      );
      expect(
        JSON.stringify(
          decryptSecret(
            stored.rows[0].encrypted_credentials,
            `organization:${f.tenantA}:linkedin_jobs:production`,
          ),
        ),
      ).not.toContain(setupBody.clientSecret);
    });
  });
});
