import { createHash, randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { Role } from '../../src/shared/enums';
import { EmailPort, InvitationEmail } from '../../src/integrations';
import { DbService } from '../../src/platform/database/db.service';
import { runWithTenant } from '../../src/platform/database/tenant-context';
import { SaasService } from '../../src/modules/saas';
import { useApiFixture, api } from '../helpers/api-fixtures';

describe('SaaS platform provisioning and organization invitations', () => {
  const f = useApiFixture();
  let platformToken: string, platformUser: string;
  let emails: InvitationEmail[] = [];
  const created: string[] = [];
  const password = 'Invitation-password-2026!';
  const origin = 'http://localhost:5173';
  async function token(userId: string, tenantId: string) {
    return f.app!.get(JwtService).signAsync(
      { sub: userId, tenantId },
      {
        expiresIn: 900,
        algorithm: 'HS256',
        issuer: 'suretek-hireai',
        audience: 'suretek-api',
      },
    );
  }
  const client = () => request(f.app!.getHttpServer());
  beforeAll(async () => {
    await f.pool.query('UPDATE tenants SET is_platform=true WHERE id=$1', [
      f.tenantA,
    ]);
    const u = await f.user(f.tenantA, Role.SUPER_ADMIN);
    platformUser = u.id;
    platformToken = await token(u.id, f.tenantA);
    jest
      .spyOn(f.app!.get(EmailPort), 'sendInvitation')
      .mockImplementation(async (message) => {
        emails.push(message);
        return true;
      });
  });
  afterEach(async () => {
    for (const id of created.splice(0)) {
      await f.pool.query(
        'DELETE FROM platform_organizations WHERE organization_id=$1',
        [id],
      );
      for (const table of ['user_invitations', 'audit_events', 'users'])
        await f.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
      await f.pool.query('DELETE FROM tenants WHERE id=$1', [id]);
    }
    emails = [];
  });
  async function provision() {
    const slug = `org-${randomUUID()}`;
    const response = await client()
      .post(`${api}/saas/organizations`)
      .auth(platformToken, { type: 'bearer' })
      .send({
        name: 'Example organization',
        slug,
        adminName: 'Organization admin',
        adminEmail: 'admin@organization.test',
      })
      .expect(201);
    created.push(response.body.id);
    return { id: response.body.id, slug, response };
  }
  async function accept(mail: InvitationEmail, extra = {}) {
    return client()
      .post(`${api}/saas/invitations/accept`)
      .set('Origin', origin)
      .send({
        organizationSlug: mail.organizationSlug,
        token: mail.token,
        password,
        ...extra,
      });
  }
  it('limits platform administrators to organizations and denies platform access to other accounts', async () => {
    await client()
      .get(`${api}/saas/organizations`)
      .auth(platformToken, { type: 'bearer' })
      .expect(200);
    for (const path of ['/jobs', '/candidates', '/employees', '/saas/users'])
      await client()
        .get(`${api}${path}`)
        .auth(platformToken, { type: 'bearer' })
        .expect(403);
    await client()
      .get(`${api}/saas/organizations`)
      .auth(f.tokenB, { type: 'bearer' })
      .expect(403);
    await client()
      .post(`${api}/saas/organizations`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({})
      .expect(403);
    const legacy = await f.user(f.tenantB, Role.SUPER_ADMIN);
    await client()
      .get(`${api}/saas/organizations`)
      .auth(await token(legacy.id, f.tenantB), { type: 'bearer' })
      .expect(403);
    const db = f.app!.get(DbService);
    await expect(
      runWithTenant(f.tenantB, () =>
        db.query('SELECT * FROM provision_organization($1,$2,$3,$4,$5,$6,$7)', [
          f.adminB.id,
          'No',
          'not-allowed',
          'No',
          'n@example.test',
          '0'.repeat(64),
          new Date(Date.now() + 60000),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('creates a separate organization with an inactive admin, emails an invitation and accepts it once', async () => {
    const org = await provision();
    const mail = emails[0];
    expect(org.response.body.deliveryStatus).toBe('SENT');
    expect(JSON.stringify(org.response.body)).not.toContain(mail.token);
    const user = (
      await f.pool.query('SELECT * FROM users WHERE tenant_id=$1', [org.id])
    ).rows[0];
    expect(user).toMatchObject({
      role: Role.HR_ADMIN,
      active: false,
      invitation_pending: true,
    });
    const invitation = (
      await f.pool.query('SELECT * FROM user_invitations WHERE tenant_id=$1', [
        org.id,
      ])
    ).rows[0];
    expect(invitation.token_hash).toBe(
      createHash('sha256').update(mail.token).digest('hex'),
    );
    expect(JSON.stringify(invitation)).not.toContain(mail.token);
    await client()
      .post(`${api}/auth/session`)
      .set('Origin', origin)
      .send({ organizationSlug: org.slug, email: mail.to, password })
      .expect(401);
    await accept(mail, { role: Role.SUPER_ADMIN }).then((r) =>
      expect(r.status).toBe(400),
    );
    await accept(mail).then((r) => expect(r.status).toBe(200));
    await accept(mail).then((r) => expect(r.status).toBe(400));
    const agent = request.agent(f.app!.getHttpServer());
    await agent
      .post(`${api}/auth/session`)
      .set('Origin', origin)
      .send({ organizationSlug: org.slug, email: mail.to, password })
      .expect(200);
    const session = await agent.get(`${api}/auth/session`).expect(200);
    expect(session.body.user).toMatchObject({
      role: Role.HR_ADMIN,
      tenant_id: org.id,
      organization_slug: org.slug,
      platform_admin: false,
    });
    await agent.get(`${api}/saas/organizations`).expect(403);
    const members = await agent.get(`${api}/saas/users`).expect(200);
    expect(members.body.data.map((u: { id: string }) => u.id)).toEqual([
      user.id,
    ]);
    await client()
      .get(`${api}/saas/users`)
      .auth(f.tokenB, { type: 'bearer' })
      .expect(200)
      .then((r) => expect(JSON.stringify(r.body)).not.toContain(user.id));
  });
  it('forces the initial admin role and rolls back duplicate organization creation', async () => {
    const org = await provision();
    const requestBody = {
      name: 'Duplicate',
      slug: org.slug,
      adminName: 'Other',
      adminEmail: 'other@organization.test',
    };
    await client()
      .post(`${api}/saas/organizations`)
      .auth(platformToken, { type: 'bearer' })
      .send({ ...requestBody, adminRole: Role.SUPER_ADMIN })
      .expect(400);
    await client()
      .post(`${api}/saas/organizations`)
      .auth(platformToken, { type: 'bearer' })
      .send(requestBody)
      .expect(409);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM tenants WHERE slug=$1',
          [org.slug],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('resends failed or expired invitations, invalidates old links, and does not reset accepted accounts', async () => {
    jest
      .mocked(f.app!.get(EmailPort).sendInvitation)
      .mockResolvedValueOnce(false);
    const org = await provision();
    expect(org.response.body.deliveryStatus).toBe('FAILED');
    await client()
      .post(`${api}/saas/organizations/${org.id}/admin-invitation`)
      .auth(platformToken, { type: 'bearer' })
      .expect(201);
    const old = emails.at(-1)!;
    await f.pool.query(
      "UPDATE user_invitations SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",
      [org.id],
    );
    await accept(old).then((r) => expect(r.status).toBe(400));
    await client()
      .post(`${api}/saas/organizations/${org.id}/admin-invitation`)
      .auth(platformToken, { type: 'bearer' })
      .expect(201);
    const latest = emails.at(-1)!;
    await accept(old).then((r) => expect(r.status).toBe(400));
    await accept(latest).then((r) => expect(r.status).toBe(200));
    await client()
      .post(`${api}/saas/organizations/${org.id}/admin-invitation`)
      .auth(platformToken, { type: 'bearer' })
      .expect(409);
  });
  it('allows org admins to invite staff roles only, and refuses cross-organization management', async () => {
    const roles = [
      Role.RECRUITER,
      Role.HIRING_MANAGER,
      Role.INTERVIEWER,
      Role.CANDIDATE,
      Role.EMPLOYEE,
      Role.REPORTING_MANAGER,
      Role.PAYROLL_FINANCE,
      Role.IT_ASSET_ADMIN,
    ] as const;
    const service = f.app!.get(SaasService);
    for (const role of roles) {
      const actor = {
        tenantId: f.tenantB,
        userId: f.adminB.id,
        role: Role.HR_ADMIN,
      };
      const result = await runWithTenant(f.tenantB, () =>
        service.inviteStaff(actor, {
          fullName: 'Invited staff',
          email: `${role.toLowerCase()}@invite.test`,
          role,
        }),
      );
      const saved = (
        await f.pool.query(
          'SELECT role,active,invitation_pending FROM users WHERE tenant_id=$1 AND id=$2',
          [f.tenantB, result.id],
        )
      ).rows[0];
      expect(saved).toEqual({ role, active: false, invitation_pending: true });
    }
    for (const role of [Role.SUPER_ADMIN, Role.HR_ADMIN])
      await client()
        .post(`${api}/saas/invitations`)
        .auth(f.tokenB, { type: 'bearer' })
        .send({
          fullName: 'Forbidden admin',
          email: 'escalate@example.test',
          role,
        })
        .expect(400);
    await client()
      .post(`${api}/auth/users`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({
        fullName: 'Forbidden admin',
        email: 'escalate@example.test',
        password,
        role: Role.SUPER_ADMIN,
      })
      .expect(403);
    await client()
      .post(`${api}/saas/users/${f.adminA.id}/invitation`)
      .auth(f.tokenB, { type: 'bearer' })
      .expect(404);
    await client()
      .patch(`${api}/auth/users/${f.adminA.id}/status`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({ active: false })
      .expect(404);
    await client()
      .post(`${api}/saas/invitations`)
      .auth(f.employeeToken, { type: 'bearer' })
      .send({})
      .expect(403);
  });
  it('rejects cancelled invitations and permits explicit re-invitation without reviving deactivated accepted users', async () => {
    const invited = await client()
      .post(`${api}/saas/invitations`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({
        fullName: 'Cancelled staff',
        email: 'cancelled@invite.test',
        role: Role.RECRUITER,
      })
      .expect(201);
    const old = emails.at(-1)!;
    await client()
      .patch(`${api}/auth/users/${invited.body.id}/status`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({ active: false })
      .expect(200);
    await accept(old).then((r) => expect(r.status).toBe(400));
    await client()
      .patch(`${api}/auth/users/${invited.body.id}/status`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({ active: true })
      .expect(403);
    await client()
      .post(`${api}/saas/users/${invited.body.id}/invitation`)
      .auth(f.tokenB, { type: 'bearer' })
      .expect(201);
    const newest = emails.at(-1)!;
    const replies = await Promise.all([accept(newest), accept(newest)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
    await client()
      .patch(`${api}/auth/users/${invited.body.id}/status`)
      .auth(f.tokenB, { type: 'bearer' })
      .send({ active: false })
      .expect(200);
    await client()
      .post(`${api}/saas/users/${invited.body.id}/invitation`)
      .auth(f.tokenB, { type: 'bearer' })
      .expect(409);
    await accept(newest).then((r) => expect(r.status).toBe(400));
  });
  it('keeps invitation and control-plane tables under forced RLS', async () => {
    const db = f.app!.get(DbService);
    await expect(
      runWithTenant(f.tenantB, () =>
        db.query('SELECT * FROM platform_organizations'),
      ),
    ).resolves.toEqual([]);
    const other = await runWithTenant(f.tenantA, () =>
      db.query('SELECT * FROM user_invitations'),
    );
    expect(other).toEqual([]);
    expect(platformUser).toBeTruthy();
  });
});
