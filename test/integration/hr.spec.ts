import { useApiFixture } from '../helpers/api-fixtures';
import { randomUUID } from 'node:crypto';
import { OfferStatus, LeaveType, LeaveStatus } from '../../src/shared/enums';

describe('PostgreSQL-backed API invariants', () => {
  const fixture = useApiFixture();

  it('scopes core HR, reviews leave once and rejects duplicate daily attendance', async () => {
    const { pool, tenantA, adminA, tokenB, authorized, scenario } = fixture;
    const { candidateId, applicationId } = await scenario();
    const offerId = randomUUID();
    const employeeId = randomUUID();
    await pool.query(
      `INSERT INTO offers (id,tenant_id,application_id,status,annual_ctc,currency,joining_date,created_by,approved_by,accepted_at,acceptance_reference)
       VALUES ($1,$2,$3,$4,'900000.00','INR','2026-12-01',$5,$5,now(),'Fixture acceptance')`,
      [offerId, tenantA, applicationId, OfferStatus.ACCEPTED, adminA.id],
    );
    await pool.query(
      `INSERT INTO employees (id,tenant_id,candidate_id,source_offer_id,employee_code,full_name,email,joining_date,annual_ctc,currency)
       VALUES ($1,$2,$3,$4,$5,'HR Fixture Employee',$6,'2026-12-01','900000.00','INR')`,
      [
        employeeId,
        tenantA,
        candidateId,
        offerId,
        `TEST-${employeeId}`,
        `${employeeId}@example.test`,
      ],
    );
    await authorized('get', `/employees/${employeeId}`, tokenB).expect(404);
    const leaveBody = {
      employeeId,
      type: LeaveType.ANNUAL,
      startDate: '2026-12-10',
      endDate: '2026-12-11',
      reason: 'Annual leave',
    };
    await authorized('post', '/leave-requests', tokenB)
      .send(leaveBody)
      .expect(404);
    await authorized('post', '/leave-requests')
      .send({ ...leaveBody, endDate: '2026-12-09' })
      .expect(400);
    const leave = await authorized('post', '/leave-requests')
      .send(leaveBody)
      .expect(201);
    const reviewed = await authorized(
      'post',
      `/leave-requests/${leave.body.id}/review`,
    )
      .send({ status: LeaveStatus.APPROVED })
      .expect(201);
    expect(reviewed.body.status).toBe(LeaveStatus.APPROVED);
    await authorized('post', `/leave-requests/${leave.body.id}/review`)
      .send({ status: LeaveStatus.REJECTED })
      .expect(409);
    const attendance = {
      employeeId,
      workDate: '2026-12-02',
      checkIn: '2026-12-02T09:00:00+05:30',
      checkOut: '2026-12-02T18:00:00+05:30',
    };
    await authorized('post', '/attendance', tokenB)
      .send(attendance)
      .expect(404);
    await authorized('post', '/attendance').send(attendance).expect(201);
    await authorized('post', '/attendance').send(attendance).expect(409);
  });
});
