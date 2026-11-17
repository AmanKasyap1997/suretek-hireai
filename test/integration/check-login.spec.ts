import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { checkLogin } from '../../scripts/check-login';
import { useApiFixture } from '../helpers/api-fixtures';

describe('local login diagnostic', () => {
  const f = useApiFixture();
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  });
  afterAll(async () => pool?.end());
  it('distinguishes tenant/account/password failures without changing credentials', async () => {
    const before = await f.pool.query('SELECT * FROM users WHERE id=$1', [
      f.adminA.id,
    ]);
    const input = {
      tenantId: f.tenantA,
      email: f.adminA.email,
      password: 'Integration-only-password-2026!',
    };
    await expect(checkLogin(pool, input)).resolves.toBe('credentials-match');
    await expect(
      checkLogin(pool, { ...input, password: 'wrong' }),
    ).resolves.toBe('password-mismatch');
    await expect(
      checkLogin(pool, { ...input, password: undefined }),
    ).resolves.toBe('password-unchecked');
    await expect(
      checkLogin(pool, { ...input, tenantId: f.tenantB }),
    ).resolves.toBe('account-missing');
    await expect(
      checkLogin(pool, { ...input, tenantId: randomUUID() }),
    ).resolves.toBe('tenant-missing');
    const after = await f.pool.query('SELECT * FROM users WHERE id=$1', [
      f.adminA.id,
    ]);
    expect(after.rows).toEqual(before.rows);
    await f.pool.query('UPDATE users SET active=false WHERE id=$1', [
      f.disabledUser.id,
    ]);
    await expect(
      checkLogin(pool, { ...input, email: f.disabledUser.email }),
    ).resolves.toBe('account-disabled');
  });
});
