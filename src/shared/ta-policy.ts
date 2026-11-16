import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DbClient } from '../platform/database/db.service';
import { Actor } from './actor';
import { Role, ApplicationStage } from './enums';
export function isScoped(actor: Actor) {
  return actor.role === Role.HIRING_MANAGER || actor.role === Role.INTERVIEWER;
}
@Injectable()
export class AccessPolicy {
  predicate(actor: Actor, job: string, userParameter: number) {
    return isScoped(actor)
      ? ` AND EXISTS (SELECT 1 FROM job_assignments assignment WHERE assignment.tenant_id=$1 AND assignment.job_id=${job} AND assignment.user_id=$${userParameter} AND assignment.role='${actor.role}')`
      : '';
  }
  async assertJob(db: DbClient, actor: Actor, id: string) {
    const params: unknown[] = [actor.tenantId, id];
    if (isScoped(actor)) params.push(actor.userId);
    const job = await db.one(
      `SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2${this.predicate(actor, 'jobs.id', 3)}`,
      params,
    );
    if (!job) throw new NotFoundException('Job not found.');
  }
  assertStage(actor: Actor, stage: ApplicationStage) {
    if (
      isScoped(actor) &&
      (actor.role !== Role.HIRING_MANAGER ||
        ![ApplicationStage.SHORTLISTED, ApplicationStage.REJECTED].includes(
          stage,
        ))
    )
      throw new ForbiddenException('Stage decision is not permitted.');
  }
}
