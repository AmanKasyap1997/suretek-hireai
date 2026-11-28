import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Role } from '../../src/shared/enums';
import { useApiFixture, api } from '../helpers/api-fixtures';
import { EmailPort } from '../../src/integrations';
describe('Super Admin governance APIs', () => {
  const f = useApiFixture();
  describe('governance scenarios', () => {
    let token: string;
    const organizations: string[] = [];
    beforeAll(async () => {
      await f.pool.query('UPDATE tenants SET is_platform=true WHERE id=$1', [
        f.tenantA,
      ]);
      token = await signed(await f.user(f.tenantA, Role.SUPER_ADMIN));
      jest
        .spyOn(f.app!.get(EmailPort), 'sendInvitation')
        .mockResolvedValue(true);
    });
    afterAll(async () => {
      for (const id of organizations) {
        await f.pool.query(
          'DELETE FROM platform_organizations WHERE organization_id=$1',
          [id],
        );
        for (const table of ['user_invitations', 'audit_events', 'users'])
          await f.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
        await f.pool.query('DELETE FROM tenants WHERE id=$1', [id]);
      }
    });
    async function signed(user: { id: string; tenantId: string }) {
      return f.app!.get(JwtService).signAsync(
        { sub: user.id, tenantId: user.tenantId },
        {
          expiresIn: 900,
          algorithm: 'HS256',
          issuer: 'suretek-hireai',
          audience: 'suretek-api',
        },
      );
    }
    const req = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => {
      const client = request(f.app!.getHttpServer());
      return client[method](api + '/super-admin' + path).auth(token, {
        type: 'bearer',
      });
    };
    async function create(domain = `${randomUUID()}.example.test`) {
      const body = {
        name: 'Governance fixture',
        slug: 'org-' + randomUUID(),
        adminName: 'HR Admin',
        adminEmail: 'admin@example.test',
        domain,
      };
      const r = await req('post', '/organizations').send(body).expect(201);
      organizations.push(r.body.id);
      return { id: r.body.id, body };
    }
    it('requires authentication and rejects organization roles', async () => {
      await request(f.app!.getHttpServer())
        .get(api + '/super-admin/dashboard')
        .expect(401);
      await f.authorized('get', '/super-admin/dashboard').expect(403);
      await req('get', '/organizations?limit=101').expect(400);
    });
    it('creates atomically and rolls back the entire organization on duplicate domain', async () => {
      const first = await create();
      const slug = 'rollback-' + randomUUID();
      await req('post', '/organizations')
        .send({ ...first.body, slug })
        .expect(409);
      const leaked = await f.pool.query(
        'SELECT id FROM tenants WHERE slug=$1',
        [slug],
      );
      expect(leaked.rowCount).toBe(0);
      const members = await f.pool.query(
        'SELECT status FROM users WHERE tenant_id=$1',
        [first.id],
      );
      expect(members.rows[0].status).toBe('invited');
    });
    it('blocks suspended logins and existing sessions, then reactivates without deleting data', async () => {
      const org = await create();
      const member = await f.user(org.id, Role.EMPLOYEE),
        memberToken = await signed(member);
      await req('post', `/organizations/${org.id}/status`)
        .send({ status: 'suspended' })
        .expect(400);
      await req('post', `/organizations/${org.id}/status`)
        .send({ status: 'suspended', reason: 'Billing review' })
        .expect(201);
      await f.authorized('get', '/auth/me', memberToken).expect(423);
      await req('post', `/organizations/${org.id}/invitation`).expect(409);
      await request(f.app!.getHttpServer())
        .post(api + '/auth/login')
        .send({
          tenantId: org.id,
          email: member.email,
          password: 'Integration-only-password-2026!',
        })
        .expect(423);
      await req('post', `/organizations/${org.id}/status`)
        .send({ status: 'active' })
        .expect(201);
      await f.authorized('get', '/auth/me', memberToken).expect(200);
    });
    it('returns aggregate usage, pagination and filters without candidate data', async () => {
      const org = await create();
      const r = await req(
        'get',
        '/organizations?limit=1&search=Governance',
      ).expect(200);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.pagination.total).toBeGreaterThan(0);
      const detail = await req('get', `/organizations/${org.id}`).expect(200);
      expect(detail.body.usage.users).toBe(1);
      expect(detail.body.candidates).toBeUndefined();
      await f.authorized('get', '/candidates', token).expect(403);
      await f
        .authorized('get', `/super-admin/organizations/${org.id}`, f.tokenB)
        .expect(403);
      const logs = await req(
        'get',
        `/audit-logs?organization_id=${org.id}`,
      ).expect(200);
      expect(
        logs.body.data.some(
          (r: { action: string }) => r.action === 'organization.created',
        ),
      ).toBe(true);
    });
    it('reports this month’s AI calls and organizations’ failing connections', async () => {
      const org = await create();
      const admin = (
        await f.pool.query('SELECT id FROM users WHERE tenant_id=$1 LIMIT 1', [
          org.id,
        ])
      ).rows[0];
      const { rows } = await f.pool.query(
        `INSERT INTO integration_providers(provider,tenant_id,enabled,updated_by) VALUES('google_calendar',$1,true,$2)
         ON CONFLICT(provider) DO UPDATE SET enabled=true RETURNING revision`,
        [f.tenantA, f.adminA.id],
      );
      const config = await f.pool.query(
        `INSERT INTO integration_configs(tenant_id,organization_id,scope,provider,environment,method,status,encrypted_credentials,credential_hint,provider_revision,updated_by,error_count)
         VALUES($1,$1,'organization','google_calendar','production','bearer','failing','','****oken',$2,$3,3) RETURNING id`,
        [org.id, rows[0].revision, admin.id],
      );
      try {
        const report = await req('get', '/reports').expect(200);
        const mine = report.body.organizations.find(
          (o: { id: string }) => o.id === org.id,
        );
        // Calls and minutes come from this month's AI call attempts.
        expect(mine.usage).toMatchObject({
          calls: 0,
          call_minutes: 0,
          storage_mb: 0,
          integrations_failing: 1,
          integration_errors: 3,
        });
        expect(mine.usage).not.toHaveProperty('unmetered_calls');
        expect(report.body.integrations).toContainEqual(
          expect.objectContaining({
            organization: 'Governance fixture',
            provider: 'google_calendar',
            status: 'failing',
            error_count: 3,
          }),
        );
      } finally {
        await f.pool.query('DELETE FROM integration_configs WHERE id=$1', [
          config.rows[0].id,
        ]);
      }
    });

    it('enforces module disabling and protects the last Super Admin', async () => {
      const id = organizations[organizations.length - 1];
      const detail = (await req('get', '/organizations/' + id).expect(200))
        .body;
      const member = await f.user(id, Role.RECRUITER),
        memberToken = await signed(member);
      const profile = {
        name: detail.name,
        domain: detail.domain,
        country: detail.country,
        timezone: detail.timezone,
        plan: detail.plan,
        status: 'active',
        limits: detail.limits,
        enabled_modules: [],
        trial_ends_at: null,
      };
      await req('patch', '/organizations/' + id)
        .send(profile)
        .expect(200);
      await f.authorized('get', '/jobs', memberToken).expect(403);
      await f.authorized('get', '/JoBs', memberToken).expect(403);
      const admins = await req('get', '/admins').expect(200);
      await req('patch', '/admins/' + admins.body[0].id)
        .send({ active: false })
        .expect(409);
    });
    it('never returns credentials and requires verified sandbox before production', async () => {
      const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
      process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
      const fetcher = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));
      try {
        const sandbox = await req('post', '/integrations')
          .send({
            provider: 'openai',
            environment: 'sandbox',
            credential: 'test-secret-sandbox',
          })
          .expect(201);
        const production = await req('post', '/integrations')
          .send({
            provider: 'openai',
            environment: 'production',
            credential: 'test-secret-production',
          })
          .expect(201);
        await req(
          'post',
          '/integrations/' + production.body.id + '/enable',
        ).expect(409);
        await req(
          'post',
          '/integrations/' + production.body.id + '/test',
        ).expect(201);
        await req(
          'post',
          '/integrations/' + production.body.id + '/enable',
        ).expect(409);
        await req('post', '/integrations/' + sandbox.body.id + '/test').expect(
          201,
        );
        await req(
          'post',
          '/integrations/' + production.body.id + '/enable',
        ).expect(201);
        const list = await req('get', '/integrations').expect(200);
        expect(JSON.stringify(list.body)).not.toContain('test-secret');
        expect(list.body[0].encrypted_credentials).toBeUndefined();
        fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }));
        const failed = await req(
          'post',
          '/integrations/' + sandbox.body.id + '/test',
        ).expect(201);
        expect(failed.body.ok).toBe(false);
        const revoked = await req('get', '/integrations').expect(200);
        expect(
          revoked.body.find((r: { id: string }) => r.id === production.body.id)
            .status,
        ).toBe('unverified');
        await req(
          'post',
          '/integrations/' + production.body.id + '/enable',
        ).expect(409);
        await req('post', '/integrations')
          .send({
            provider: 'openai',
            environment: 'sandbox',
            credential: 'rotated-secret-value',
          })
          .expect(201);
        await req(
          'post',
          '/integrations/' + production.body.id + '/enable',
        ).expect(409);
      } finally {
        fetcher.mockRestore();
        if (previous === undefined)
          delete process.env.INTEGRATION_ENCRYPTION_KEY;
        else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
      }
    });
    it('includes organization integration events in the filtered audit trail', async () => {
      const id = organizations[organizations.length - 1];
      await f.pool.query(
        "INSERT INTO audit_events(tenant_id,action,entity_type,entity_id,metadata) VALUES($1,'integration.tested','integration',$2,$3)",
        [
          f.tenantA,
          randomUUID(),
          JSON.stringify({ organization_id: id, ok: false }),
        ],
      );
      const logs = await req(
        'get',
        `/audit-logs?organization_id=${id}&action=integration.tested`,
      ).expect(200);
      expect(logs.body.data).toHaveLength(1);
      expect(logs.body.data[0].metadata.organization_id).toBe(id);
      const csv = await req(
        'get',
        `/audit-logs/export?organization_id=${id}&action=integration.tested`,
      ).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain('integration.tested');
    });
    it('requires typed confirmation for soft deletion and retains users', async () => {
      const id = organizations[0];
      await req('delete', `/organizations/${id}`)
        .send({ confirmation: 'wrong' })
        .expect(400);
      await req('delete', `/organizations/${id}`)
        .send({ confirmation: 'Governance fixture' })
        .expect(200);
      await req('get', `/organizations/${id}`).expect(404);
      await req('post', `/organizations/${id}/invitation`).expect(404);
      const legacy = await f
        .authorized('get', '/saas/organizations', token)
        .expect(200);
      expect(legacy.body.data.some((r: { id: string }) => r.id === id)).toBe(
        false,
      );
      const r = await f.pool.query(
        'SELECT count(*)::int AS count FROM users WHERE tenant_id=$1',
        [id],
      );
      expect(r.rows[0].count).toBeGreaterThan(0);
    });
  });
});
