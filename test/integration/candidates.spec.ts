import { useApiFixture } from '../helpers/api-fixtures';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('validates bodies and prevents client-supplied tenant authority', async () => {
    const { tenantB, authorized } = fixture;
    await authorized('post', '/candidates')
      .send({ fullName: 'Invalid', email: 'not-email' })
      .expect(400);
    await authorized('post', '/candidates')
      .send({
        tenantId: tenantB,
        fullName: 'Injected',
        email: 'injected@example.test',
      })
      .expect(400);
    await authorized('get', '/candidates?limit=1000').expect(400);
    await authorized('get', '/candidates/not-a-uuid').expect(400);
  });

  it('returns client errors for malformed JSON and bodies exceeding the upload limit', async () => {
    const { authorized } = fixture;
    await authorized('post', '/candidates')
      .set('Content-Type', 'application/json')
      .send('{"fullName":')
      .expect(400);
    await authorized('post', '/candidates')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }))
      .expect(413);
  });

  it('deduplicates candidate emails without case sensitivity within the same tenant', async () => {
    const { pool, tenantA, authorized } = fixture;
    await authorized('post', '/candidates')
      .send({
        fullName: 'Duplicate Candidate',
        email: 'CANDIDATE@example.test',
      })
      .expect(409);
    const count = await pool.query(
      'SELECT count(*) AS count FROM candidates WHERE tenant_id=$1 AND lower(email)=$2',
      [tenantA, 'candidate@example.test'],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });
});
