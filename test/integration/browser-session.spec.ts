import request from 'supertest';
import { useApiFixture, api } from '../helpers/api-fixtures';
describe('browser cookie authentication', () => {
  const f = useApiFixture();
  it('keeps tokens HttpOnly, returns the correct tenant, rejects CSRF and clears logout', async () => {
    const agent = request.agent(f.app!.getHttpServer());
    const body = {
      tenantId: f.adminA.tenantId,
      email: f.adminA.email,
      password: 'Integration-only-password-2026!',
    };
    await agent
      .post(`${api}/auth/session`)
      .set('Origin', 'https://evil.test')
      .send(body)
      .expect(403);
    const login = await agent
      .post(`${api}/auth/session`)
      .set('Origin', 'http://localhost:5173')
      .send(body)
      .expect(200);
    expect(login.body.accessToken).toBeUndefined();
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly/);
    const me = await agent.get(`${api}/auth/session`).expect(200);
    expect(me.body.user.tenant_id).toBe(f.tenantA);
    expect(me.body.user.id).toBe(f.adminA.id);
    expect(me.body.expiresAt).toBeGreaterThan(Date.now());
    await agent.post(`${api}/jobs`).send({}).expect(403);
    await agent
      .delete(`${api}/auth/session`)
      .set('Origin', 'https://evil.test')
      .expect(403);
    await agent
      .delete(`${api}/auth/session`)
      .set('Origin', 'http://localhost:5173')
      .expect(204);
    await agent.get(`${api}/auth/session`).expect(401);
  });
});
