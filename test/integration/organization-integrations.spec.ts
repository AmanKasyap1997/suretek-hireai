import { DbService } from '../../src/platform/database/db.service';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { ThrottlerStorageService, getStorageToken } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Role } from '../../src/shared/enums';
import { api, useApiFixture } from '../helpers/api-fixtures';
import * as client from '../../src/modules/organization-integrations/provider-client';
import { decryptSecret } from '../../src/modules/super-admin/secrets';
describe('Organization-owned integrations', () => {
  const f = useApiFixture();
  describe('scenarios', () => {
    let platform: string, other: string, otherTenant: string;
    const base = '/organization/integrations';
    const input = {
      provider: 'openai',
      environment: 'sandbox',
      method: 'api_key',
      credentials: { apiKey: 'fixture-secret-never-return-1234' },
    };
    beforeAll(async () => {
      process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
      process.env.PUBLIC_WEB_BASE_URL = 'http://localhost:5173';
      await f.pool.query('UPDATE tenants SET is_platform=true WHERE id=$1', [
        f.tenantA,
      ]);
      const sign = async (user: { id: string; tenantId: string }) =>
        f.app!.get(JwtService).signAsync(
          { sub: user.id, tenantId: user.tenantId },
          {
            expiresIn: 900,
            algorithm: 'HS256',
            issuer: 'suretek-hireai',
            audience: 'suretek-api',
          },
        );
      platform = await sign(await f.user(f.tenantA, Role.SUPER_ADMIN));
      otherTenant = randomUUID();
      await f.pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
        otherTenant,
        'Other integration organization',
      ]);
      other = await sign(await f.user(otherTenant, Role.HR_ADMIN));
    });
    afterAll(async () => {
      await f.pool.query('DELETE FROM audit_events WHERE tenant_id=$1', [
        otherTenant,
      ]);
      await f.pool.query('DELETE FROM users WHERE tenant_id=$1', [otherTenant]);
      await f.pool.query('DELETE FROM tenants WHERE id=$1', [otherTenant]);
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      delete process.env.PUBLIC_WEB_BASE_URL;
    });
    const admin = (method: 'get' | 'post' | 'delete', path: string) =>
      f.authorized(method, base + path, f.tokenB);
    const toggle = (enabled: boolean, provider = 'openai') =>
      f
        .authorized(
          'patch',
          '/super-admin/integration-providers/' + provider,
          platform,
        )
        .send({ enabled });
    it('registers the reported URLs and denies unauthorized callers (not 404)', async () => {
      for (const path of [
        '/super-admin/organizations',
        '/super-admin/integrations',
        base,
        base + '/providers',
      ])
        await request(f.app!.getHttpServer())
          .get(api + path)
          .expect(401);
      await f
        .authorized('get', '/super-admin/organizations', platform)
        .expect(200);
      await f
        .authorized('get', '/super-admin/integrations', platform)
        .expect(200);
      await f
        .authorized('get', '/super-admin/integrations', f.tokenB)
        .expect(403);
      await f.authorized('get', base, platform).expect(403);
    });
    it('requires platform enablement and rejects scope/credential method tampering', async () => {
      expect((await admin('get', '/providers').expect(200)).body).toEqual([]);
      await admin('post', '').send(input).expect(403);
      await f
        .authorized(
          'patch',
          '/super-admin/integration-providers/openai',
          f.tokenB,
        )
        .send({ enabled: true })
        .expect(403);
      await toggle(true).expect(200);
      const providers = (await admin('get', '/providers').expect(200)).body;
      expect(providers.map((p: { provider: string }) => p.provider)).toEqual([
        'openai',
      ]);
      await admin('post', '')
        .send({ ...input, organization_id: f.tenantA })
        .expect(400);
      await admin('post', '')
        .send({
          ...input,
          method: 'basic',
          credentials: { username: 'a', password: 'b' },
        })
        .expect(400);
      await admin('post', '')
        .send({
          ...input,
          credentials: { apiKey: 'x', endpoint: 'http://localhost' },
        })
        .expect(400);
    });
    it('keeps the shared catalog read-only for organization database scopes', async () => {
      const db = f.app!.get(DbService);
      await runWithTenant(f.tenantB, async () => {
        expect(
          await db.query(
            "UPDATE integration_providers SET enabled=false WHERE provider='openai' RETURNING provider",
          ),
        ).toEqual([]);
        await expect(
          db.query(
            "INSERT INTO integration_providers(provider,tenant_id,updated_by) VALUES('hris',$1,$2)",
            [f.tenantB, f.adminB.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      });
      expect(
        (await admin('get', '/providers').expect(200)).body.map(
          (p: { provider: string }) => p.provider,
        ),
      ).toContain('openai');
    });
    it('encrypts tenant credentials, isolates reads and writes, and revokes stale approvals', async () => {
      const id = (await admin('post', '').send(input).expect(201)).body.id;
      const stored = (
        await f.pool.query('SELECT * FROM integration_configs WHERE id=$1', [
          id,
        ])
      ).rows[0];
      expect(stored.tenant_id).toBe(f.tenantB);
      expect(stored.encrypted_credentials).not.toContain(
        input.credentials.apiKey,
      );
      expect(
        JSON.parse(
          decryptSecret(
            stored.encrypted_credentials,
            `organization:${f.tenantB}:openai:sandbox`,
          ),
        ),
      ).toEqual(input.credentials);
      expect(
        JSON.stringify((await admin('get', '').expect(200)).body),
      ).not.toContain(input.credentials.apiKey);
      expect((await f.authorized('get', base, other).expect(200)).body).toEqual(
        [],
      );
      for (const action of ['test', 'enable'])
        await f
          .authorized('post', base + '/' + id + '/' + action, other)
          .expect(404);
      await f.authorized('delete', base + '/' + id, other).expect(404);
      const verify = jest
        .spyOn(client, 'verify')
        .mockResolvedValue({ ok: true, credentials: input.credentials });
      await admin('post', '/' + id + '/test').expect(201);
      await admin('post', '/' + id + '/enable').expect(201);
      const production = (
        await admin('post', '')
          .send({ ...input, environment: 'production' })
          .expect(201)
      ).body.id;
      await admin('post', '/' + production + '/enable').expect(409);
      await admin('post', '/' + production + '/test').expect(201);
      await admin('post', '/' + production + '/enable').expect(201);
      await toggle(false).expect(200);
      expect((await admin('get', '/providers').expect(200)).body).toEqual([]);
      await admin('post', '/' + id + '/test').expect(403);
      await admin('post', '/' + production + '/enable').expect(403);
      await toggle(true).expect(200);
      f.app!.get<ThrottlerStorageService>(
        getStorageToken(),
      ).onApplicationShutdown();
      await admin('post', '/' + production + '/enable').expect(409);
      await admin('post', '/' + production + '/test').expect(201);
      await admin('post', '/' + production + '/enable').expect(409);
      await admin('post', '/' + id + '/test').expect(201);
      await admin('post', '/' + production + '/enable').expect(201);
      await admin('delete', '/' + id).expect(200);
      await admin('post', '/' + production + '/enable').expect(409);
      const disconnected = (
        await f.pool.query(
          'SELECT encrypted_credentials FROM integration_configs WHERE id=$1',
          [id],
        )
      ).rows[0];
      expect(disconnected.encrypted_credentials).toBe('');
      verify.mockRestore();
    });
    it('binds OAuth state to the initiating organization/user and consumes it once', async () => {
      await toggle(true, 'google_calendar').expect(200);
      const body = {
        provider: 'google_calendar',
        environment: 'sandbox',
        method: 'oauth2',
        credentials: {
          clientId: 'fixture-client',
          clientSecret: 'fixture-client-secret',
        },
      };
      const start = await admin('post', '/oauth/start').send(body).expect(201);
      const url = new URL(start.body.authorizationUrl),
        state = url.searchParams.get('state');
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(start.text).not.toContain(body.credentials.clientSecret);
      await f
        .authorized('post', base + '/oauth/complete', other)
        .send({ state, code: 'fixture-code' })
        .expect(400);
      const exchange = jest.spyOn(client, 'exchange').mockResolvedValue({
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
      });
      await admin('post', '/oauth/complete')
        .send({ state, code: 'fixture-code' })
        .expect(201);
      await admin('post', '/oauth/complete')
        .send({ state, code: 'fixture-code' })
        .expect(400);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect((await admin('get', '').expect(200)).text).not.toContain(
        'fixture-refresh-token',
      );
      exchange.mockRestore();
    });
  });
});
