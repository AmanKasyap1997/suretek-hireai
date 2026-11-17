import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { useApiFixture, api } from '../helpers/api-fixtures';

describe('Platform authentication governance', () => {
  const f = useApiFixture();
  it('returns generic 401 and anonymous audit evidence for unknown organizations', async () => {
    // The platform directory is consulted by the fixed audit function only.
    await f.pool.query(
      'UPDATE tenants SET is_platform=true,slug=$2 WHERE id=$1',
      [f.tenantA, '000-audit-' + randomUUID()],
    );
    for (const organization of [
      { tenantId: randomUUID() },
      { organizationSlug: 'missing-' + randomUUID() },
    ]) {
      const response = await request(f.app!.getHttpServer())
        .post(api + '/auth/session')
        .set('Origin', 'http://localhost:5173')
        .send({
          ...organization,
          email: 'unknown@example.test',
          password: 'a-private-test-password',
        })
        .expect(401);
      expect(response.body.message).toBe('Invalid credentials');
    }
    const evidence = await f.pool.query(
      "SELECT metadata,actor_id FROM audit_events WHERE tenant_id=$1 AND action='auth.login_failed'",
      [f.tenantA],
    );
    expect(evidence.rows).toEqual([
      { metadata: { reason: 'unresolved_organization' }, actor_id: null },
      { metadata: { reason: 'unresolved_organization' }, actor_id: null },
    ]);
  });
  it('applies the platform password minimum to direct staff creation', async () => {
    await f.pool.query(
      "INSERT INTO platform_settings(tenant_id,key,value,updated_by) VALUES($1,'defaults',$2,$3)",
      [f.tenantA, JSON.stringify({ password_min_length: 24 }), f.adminA.id],
    );
    await f
      .authorized('post', '/auth/users')
      .send({
        email: 'staff@example.test',
        fullName: 'Staff',
        role: 'RECRUITER',
        password: 'shorter-than-policy',
      })
      .expect(400);
  });
});
