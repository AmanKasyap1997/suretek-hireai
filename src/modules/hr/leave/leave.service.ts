import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { LeaveStatus } from '../../../shared/enums';
import { EmployeesService } from '../employees';
import { LeaveInput, LeaveListInput, LeaveReviewInput } from './leave.schemas';

@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DbService,
    private readonly employees: EmployeesService,
  ) {}

  create(actor: Actor, v: LeaveInput) {
    return this.db.transaction(async (tx) => {
      await this.employees.require(tx, actor, v.employeeId);
      const row = await tx.one(
        'INSERT INTO leave_requests(tenant_id,employee_id,type,start_date,end_date,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          actor.tenantId,
          v.employeeId,
          v.type,
          v.startDate,
          v.endDate,
          v.reason,
          actor.userId,
        ],
      );
      await audit(tx, actor, 'leave.requested', 'leave_request', row!.id);
      return row;
    });
  }

  async list(actor: Actor, p: LeaveListInput) {
    return {
      data: await this.db.query(
        'SELECT * FROM leave_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }

  review(actor: Actor, id: string, v: LeaveReviewInput) {
    return this.db.transaction(async (tx) => {
      const current = await tx.one(
        'SELECT * FROM leave_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!current) throw new NotFoundException();
      if (current.status !== LeaveStatus.PENDING)
        throw new ConflictException('Leave has already been reviewed');
      const row = await tx.one(
        'UPDATE leave_requests SET status=$3,reviewed_by=$4 WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, v.status, actor.userId],
      );
      await audit(tx, actor, 'leave.reviewed', 'leave_request', id, {
        status: v.status,
      });
      return row;
    });
  }
}
