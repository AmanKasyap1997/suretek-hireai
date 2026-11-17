import { useApiFixture, api } from '../helpers/api-fixtures';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { Role } from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('exposes public liveness/readiness and requires authentication for business APIs', async () => {
    const { app } = fixture;
    await request(app!.getHttpServer()).get(`${api}/health/live`).expect(200);
    await request(app!.getHttpServer()).get(`${api}/health/ready`).expect(200);
    await request(app!.getHttpServer()).get(`${api}/candidates`).expect(401);
  });

  it('returns a generic authentication error for a wrong password', async () => {
    const { app, adminA } = fixture;
    const response = await request(app!.getHttpServer())
      .post(`${api}/auth/login`)
      .send({
        tenantId: adminA.tenantId,
        email: adminA.email,
        password: 'incorrect-password',
      })
      .expect(401);
    expect(JSON.stringify(response.body)).not.toContain(adminA.email);
    expect(JSON.stringify(response.body)).not.toContain('password_hash');
  });

  it('rechecks active membership and denies unauthorized roles', async () => {
    const { employeeToken, disabledToken, authorized } = fixture;
    await authorized('get', '/candidates', disabledToken).expect(401);
    await authorized('get', '/jobs', employeeToken).expect(403);
  });

  it('prevents platform super admins from modifying organization accounts', async () => {
    const { app, pool, tenantA, user, authorized } = fixture;
    const first = await user(tenantA, Role.SUPER_ADMIN);
    const second = await user(tenantA, Role.SUPER_ADMIN);
    const jwt = app!.get(JwtService);
    const options = {
      expiresIn: 900,
      algorithm: 'HS256' as const,
      issuer: 'suretek-hireai',
      audience: 'suretek-api',
    };
    const firstToken = await jwt.signAsync(
      { sub: first.id, tenantId: tenantA },
      options,
    );
    const secondToken = await jwt.signAsync(
      { sub: second.id, tenantId: tenantA },
      options,
    );
    const responses = await Promise.all([
      authorized('patch', `/auth/users/${second.id}/status`, firstToken).send({
        active: false,
      }),
      authorized('patch', `/auth/users/${first.id}/status`, secondToken).send({
        active: false,
      }),
    ]);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(0);
    expect(
      responses.filter((response) => [401, 403].includes(response.status)),
    ).toHaveLength(2);
    const remaining = await pool.query(
      'SELECT count(*)::int AS count FROM users WHERE tenant_id=$1 AND role=$2 AND active=true',
      [tenantA, Role.SUPER_ADMIN],
    );
    expect(remaining.rows[0].count).toBe(2);
  });
});
