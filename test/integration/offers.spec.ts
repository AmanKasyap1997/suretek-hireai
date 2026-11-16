import { useApiFixture } from '../helpers/api-fixtures';
import { ApplicationStage } from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('creates exactly one employee, onboarding checklist and audit event under concurrent hire retries', async () => {
    const { pool, tenantA, authorized, scenario } = fixture;
    const { candidateId, applicationId } = await scenario();
    const offer = await authorized('post', '/offers')
      .send({
        applicationId,
        annualCtc: '1234567.89',
        currency: 'INR',
        joiningDate: '2026-12-01',
      })
      .expect(201);
    await authorized('post', `/offers/${offer.body.id}/hire`).expect(409);
    await authorized('post', `/offers/${offer.body.id}/approve`).expect(200);
    await authorized('post', `/offers/${offer.body.id}/accept`)
      .send({
        acceptanceReference: 'Candidate acceptance email archive ref-123',
      })
      .expect(200);
    const results = await Promise.all([
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
      authorized('post', `/offers/${offer.body.id}/hire`).expect(201),
    ]);
    const employeeId = results[0].body.id;
    expect(results.map((result) => result.body.id)).toEqual([
      employeeId,
      employeeId,
      employeeId,
    ]);
    expect(results[0].body.annual_ctc).toBe('1234567.89');
    expect(results[0].body.candidate_id).toBe(candidateId);
    const employees = await pool.query(
      'SELECT id FROM employees WHERE tenant_id=$1 AND source_offer_id=$2',
      [tenantA, offer.body.id],
    );
    expect(employees.rows).toHaveLength(1);
    const tasks = await pool.query(
      'SELECT id FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2',
      [tenantA, employeeId],
    );
    expect(tasks.rows).toHaveLength(3);
    const application = await pool.query(
      'SELECT stage FROM applications WHERE tenant_id=$1 AND id=$2',
      [tenantA, applicationId],
    );
    expect(application.rows[0].stage).toBe(ApplicationStage.HIRED);
    const events = await pool.query(
      "SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='employee.created_from_offer'",
      [tenantA, employeeId],
    );
    expect(events.rows).toHaveLength(1);
  });
});
