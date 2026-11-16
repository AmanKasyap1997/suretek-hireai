import { Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { EmployeesService } from '../employees';
import { CompletionInput } from './onboarding.schemas';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly employees: EmployeesService,
  ) {}

  async tasks(actor: Actor, id: string) {
    await this.employees.require(this.db, actor, id);
    return {
      data: await this.db.query(
        'SELECT * FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2 ORDER BY created_at,id',
        [actor.tenantId, id],
      ),
    };
  }

  complete(actor: Actor, id: string, input: CompletionInput) {
    return this.db.transaction(async (tx) => {
      const row = await tx.one(
        'UPDATE onboarding_tasks SET completed=$3 WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, input.completed],
      );
      if (!row) throw new NotFoundException();
      await audit(tx, actor, 'onboarding.task_updated', 'onboarding_task', id, {
        completed: input.completed,
      });
      return row;
    });
  }
}
