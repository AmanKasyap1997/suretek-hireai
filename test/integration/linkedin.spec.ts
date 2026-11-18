import { JwtService } from '@nestjs/jwt';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID, createHash } from 'node:crypto';
import { useApiFixture } from '../helpers/api-fixtures';
import { Role } from '../../src/shared/enums';
import {
  encryptSecret,
  decryptSecret,
} from '../../src/modules/super-admin/secrets';
import * as provider from '../../src/modules/organization-integrations/provider-client';
import * as linkedin from '../../src/modules/organization-integrations/linkedin-client';
describe('LinkedIn consent and publication', () => {
  const f = useApiFixture();
  describe('scenarios', () => {
    let platformId: string,
      platformToken: string,
      jobId: string,
      connectionId: string;
    const base = '/organization/integrations/linkedin';
    const input = () => ({
      jobId,
      channel: 'company_announcement',
      applicationUrl: 'https://careers.example.test/job',
      pageUrn: 'urn:li:organization:123',
      pageStart: 0,
      commentary: 'Join our engineering team',
    });
    beforeAll(async () => {
      Object.assign(process.env, {
        INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
        OAUTH_LINKEDIN_CLIENT_ID: 'hosted-client',
        OAUTH_LINKEDIN_CLIENT_SECRET: 'hosted-secret-never-return',
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
      for (const name of ['linkedin', 'linkedin_jobs'])
        await f.pool.query(
          'INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES($1,$2,true,$3)',
          [name, platformId, owner.id],
        );
      jobId = randomUUID();
      await f.pool.query(
        "INSERT INTO jobs(id,tenant_id,title,description,department,location,status,created_by) VALUES($1,$2,'Software engineer',$3,'Engineering','Delhi, India','PUBLISHED',$4)",
        [
          jobId,
          f.tenantA,
          'Build useful recruitment software with our engineering team. Own reliable services and collaborate with product designers and engineers.',
          f.adminA.id,
        ],
      );
      connectionId = randomUUID();
      await f.pool.query(
        "INSERT INTO integration_configs(id,tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,provider_revision,updated_by) VALUES($1,$2,$2,'organization','linkedin','production','oauth2','enabled',$3,'****oken',1,$4)",
        [
          connectionId,
          f.tenantA,
          encryptSecret(
            JSON.stringify({
              accessToken: 'fixture-access-token',
              expiresAt: String(Date.now() + 3600000),
            }),
            `organization:${f.tenantA}:linkedin:production`,
          ),
          f.adminA.id,
        ],
      );
    });
    beforeEach(() => {
      f.app!.get<ThrottlerStorageService>(
        getStorageToken(),
      ).onApplicationShutdown();
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
        'OAUTH_LINKEDIN_CLIENT_ID',
        'OAUTH_LINKEDIN_CLIENT_SECRET',
        'PUBLIC_WEB_BASE_URL',
        'LINKEDIN_JOBS_APPROVED',
      ])
        delete process.env[key];
    });
    const req = (method: 'get' | 'post', path: string) =>
      f.authorized(method, base + path);
    function authorizedPage() {
      jest.spyOn(linkedin, 'ownsPage').mockResolvedValue(true);
    }
    it('opens hosted LinkedIn consent without customer secrets and stores tokens only in the tenant', async () => {
      const list = await f
        .authorized('get', '/organization/integrations/providers')
        .expect(200);
      expect(list.text).not.toContain('hosted-secret');
      expect(
        list.body.find((p: { provider: string }) => p.provider === 'linkedin'),
      ).toMatchObject({
        fields: { oauth2: [] },
        hostedOAuth: true,
        oauthReady: true,
      });
      const start = await f
        .authorized('post', '/organization/integrations/oauth/start')
        .send({
          provider: 'linkedin',
          environment: 'sandbox',
          method: 'oauth2',
          credentials: {},
        })
        .expect(201);
      const url = new URL(start.body.authorizationUrl),
        state = url.searchParams.get('state')!;
      expect(url.origin).toBe('https://www.linkedin.com');
      expect(url.searchParams.get('scope')).toContain('w_organization_social');
      expect(url.searchParams.get('client_id')).toBe('hosted-client');
      expect(start.text).not.toContain('hosted-secret');
      const exchange = jest.spyOn(provider, 'exchange').mockResolvedValue({
        accessToken: 'consented-token',
        expiresAt: String(Date.now() + 3600000),
      });
      await f
        .authorized(
          'post',
          '/organization/integrations/oauth/complete',
          f.tokenB,
        )
        .send({ state, code: 'code' })
        .expect(400);
      const accepted = await f
        .authorized('post', '/organization/integrations/oauth/complete')
        .send({ state, code: 'code' })
        .expect(201);
      expect(exchange).toHaveBeenCalledWith(
        'linkedin',
        expect.any(URLSearchParams),
      );
      expect(String(exchange.mock.calls[0][1])).toContain(
        'client_secret=hosted-secret-never-return',
      );
      const row = (
        await f.pool.query(
          'SELECT encrypted_credentials FROM integration_configs WHERE id=$1',
          [accepted.body.id],
        )
      ).rows[0];
      const stored = JSON.parse(
        decryptSecret(
          row.encrypted_credentials,
          `organization:${f.tenantA}:linkedin:sandbox`,
        ),
      );
      expect(stored).toMatchObject({
        _hosted: 'true',
        clientId: 'hosted-client',
        accessToken: 'consented-token',
      });
      expect(stored.clientSecret).toBeUndefined();
      expect(
        (
          await f.pool.query(
            'SELECT state_hash FROM integration_oauth_states WHERE state_hash=$1',
            [createHash('sha256').update(state).digest('hex')],
          )
        ).rowCount,
      ).toBe(0);
      await f
        .authorized('post', '/organization/integrations/oauth/complete')
        .send({ state, code: 'code' })
        .expect(400);
      // Sandbox connection updates intentionally revoke production approval.
      await f.pool.query(
        "UPDATE integration_configs SET status='enabled' WHERE id=$1",
        [connectionId],
      );
    });
    it('fails closed when hosted app configuration changes during consent', async () => {
      const start = await f
        .authorized('post', '/organization/integrations/oauth/start')
        .send({
          provider: 'linkedin',
          environment: 'sandbox',
          method: 'oauth2',
        })
        .expect(201);
      const state = new URL(start.body.authorizationUrl).searchParams.get(
        'state',
      );
      process.env.OAUTH_LINKEDIN_CLIENT_SECRET = 'rotated-secret';
      const exchange = jest.spyOn(provider, 'exchange');
      await f
        .authorized('post', '/organization/integrations/oauth/complete')
        .send({ state, code: 'code' })
        .expect(409);
      expect(exchange).not.toHaveBeenCalled();
      process.env.OAUTH_LINKEDIN_CLIENT_SECRET = 'hosted-secret-never-return';
    });
    it('previews without sending, rejects foreign jobs and requires explicit confirmation', async () => {
      authorizedPage();
      const send = jest.spyOn(linkedin, 'sendLinkedIn').mockResolvedValue({
        status: 'PUBLISHED',
        remoteId: 'urn:li:share:12345',
        errorCode: null,
      });
      await f.authorized('get', base + '/jobs', platformToken).expect(403);
      await f.authorized('get', base + '/jobs', f.employeeToken).expect(403);
      const preview = await req('post', '/preview').send(input()).expect(201);
      expect(send).not.toHaveBeenCalled();
      expect(preview.body.request.author).toBe('urn:li:organization:123');
      await f
        .authorized(
          'post',
          base + '/publications/' + preview.body.id + '/publish',
          f.tokenB,
        )
        .send({ confirmed: true })
        .expect(404);
      await req('post', '/publications/' + preview.body.id + '/publish')
        .send({ confirmed: false })
        .expect(400);
      const result = await req(
        'post',
        '/publications/' + preview.body.id + '/publish',
      )
        .send({ confirmed: true })
        .expect(201);
      expect(result.body.status).toBe('PUBLISHED');
      await req('post', '/publications/' + preview.body.id + '/publish')
        .send({ confirmed: true })
        .expect(201);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (
          await f
            .authorized('get', base + '/publications', f.tokenB)
            .expect(200)
        ).body,
      ).toEqual([]);
      await req('post', '/preview')
        .send({ ...input(), jobId: randomUUID() })
        .expect(404);
      expect(
        (await req('get', '/publications').expect(200)).text,
      ).not.toContain('fixture-access-token');
    });
    it('rejects revoked page access and changed jobs before dispatch', async () => {
      const own = jest.spyOn(linkedin, 'ownsPage').mockResolvedValue(false);
      await req('post', '/preview').send(input()).expect(403);
      own.mockResolvedValue(true);
      const preview = await req('post', '/preview').send(input()).expect(201);
      await f.pool.query('UPDATE jobs SET updated_at=now() WHERE id=$1', [
        jobId,
      ]);
      const send = jest.spyOn(linkedin, 'sendLinkedIn');
      await req('post', '/publications/' + preview.body.id + '/publish')
        .send({ confirmed: true })
        .expect(409);
      expect(send).not.toHaveBeenCalled();
    });
    it('onboards Jobs credentials only through platform, submits asynchronously and polls confirmation', async () => {
      const body = {
        environment: 'production',
        companyUrn: 'urn:li:organization:123',
        clientId: 'partner-customer-id',
        clientSecret: 'partner-customer-secret',
      };
      const setupPath =
        '/super-admin/integration-providers/linkedin-jobs/organizations/' +
        f.tenantA;
      await f.authorized('post', setupPath).send(body).expect(403);
      const setup = await f
        .authorized('post', setupPath, platformToken)
        .send(body)
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
        ...body,
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
        integrationContext: body.companyUrn,
        listingType: 'BASIC',
        jobPostingOperationType: 'CREATE',
        externalJobPostingId: f.tenantA + ':' + jobId,
      });
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
    });
    it('blocks duplicate drafts for an already dispatched job and disabled providers', async () => {
      authorizedPage();
      const preview = await req('post', '/preview').send(input()).expect(201);
      const send = jest.spyOn(linkedin, 'sendLinkedIn');
      await req('post', '/publications/' + preview.body.id + '/publish')
        .send({ confirmed: true })
        .expect(409);
      expect(send).not.toHaveBeenCalled();
      await f.pool.query(
        "UPDATE integration_providers SET enabled=false WHERE provider='linkedin'",
      );
      await req('post', '/preview').send(input()).expect(403);
    });
  });
});
