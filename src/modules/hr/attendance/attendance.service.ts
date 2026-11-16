import { Injectable } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { EmployeesService } from '../employees';
import { AttendanceInput, AttendanceListInput } from './attendance.schemas';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DbService,
    private readonly employees: EmployeesService,
  ) {}

  record(actor: Actor, v: AttendanceInput) {
    return this.db.transaction(async (tx) => {
      await this.employees.require(tx, actor, v.employeeId);
      const row = await tx.one(
        'INSERT INTO attendance(tenant_id,employee_id,work_date,check_in,check_out) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [
          actor.tenantId,
          v.employeeId,
          v.workDate,
          v.checkIn,
          v.checkOut ?? null,
        ],
      );
      await audit(tx, actor, 'attendance.recorded', 'attendance', row!.id);
      return row;
    });
  }

  async list(actor: Actor, p: AttendanceListInput) {
    return {
      data: await this.db.query(
        'SELECT * FROM attendance WHERE tenant_id=$1 ORDER BY work_date DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
}
