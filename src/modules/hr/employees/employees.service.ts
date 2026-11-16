import { Injectable, NotFoundException } from '@nestjs/common';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { EmployeeListInput } from './employees.schemas';

@Injectable()
export class EmployeesService {
  constructor(private readonly db: DbService) {}

  async require(db: DbClient, actor: Actor, id: string) {
    const row = await db.one(
      'SELECT * FROM employees WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Employee not found');
    return row;
  }

  async list(actor: Actor, p: EmployeeListInput) {
    return {
      data: await this.db.query(
        'SELECT * FROM employees WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }

  get(actor: Actor, id: string) {
    return this.require(this.db, actor, id);
  }
}
