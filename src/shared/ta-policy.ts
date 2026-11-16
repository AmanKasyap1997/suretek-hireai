import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DbClient } from '../platform/database/db.service';
import { Actor } from './actor';
import { Role, ApplicationStage } from './enums';
import { InterviewMode, InterviewStatus } from './enums';
import { RECRUITMENT_ROLES } from './role-groups';

export const INTERVIEW_ROLES: readonly Role[] = [
  ...RECRUITMENT_ROLES,
  Role.HIRING_MANAGER,
  Role.INTERVIEWER,
];

export interface ScreeningCriterion {
  id: string;
  label: string;
  weight: number;
  must_have: boolean;
}

export interface InterviewAccessRecord {
  id: string;
  tenant_id: string;
  application_id: string;
  round: string;
  mode: InterviewMode;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  meeting_url: string | null;
  status: InterviewStatus;
  criteria_snapshot: ScreeningCriterion[];
}
export function isScoped(actor: Actor) {
  return actor.role === Role.HIRING_MANAGER || actor.role === Role.INTERVIEWER;
}
@Injectable()
export class AccessPolicy {
  interviewPredicate(
    actor: Actor,
    interview: string,
    userParameter: number,
    requirePanelist = false,
  ) {
    if (!INTERVIEW_ROLES.includes(actor.role)) return ' AND FALSE';
    return isScoped(actor) || requirePanelist
      ? ` AND EXISTS (SELECT 1 FROM interview_panelists panel WHERE panel.tenant_id=$1 AND panel.interview_id=${interview} AND panel.user_id=$${userParameter})`
      : '';
  }

  async assertInterview(
    db: DbClient,
    actor: Actor,
    id: string,
    options: { requirePanelist?: boolean; lock?: boolean } = {},
  ): Promise<InterviewAccessRecord> {
    if (!INTERVIEW_ROLES.includes(actor.role))
      throw new NotFoundException('Interview not found.');
    const params: unknown[] = [actor.tenantId, id];
    if (isScoped(actor) || options.requirePanelist) params.push(actor.userId);
    const interview = await db.one<InterviewAccessRecord>(
      `SELECT i.* FROM interviews i WHERE i.tenant_id=$1 AND i.id=$2${this.interviewPredicate(actor, 'i.id', 3, options.requirePanelist)}${options.lock ? ' FOR UPDATE OF i' : ''}`,
      params,
    );
    if (!interview) throw new NotFoundException('Interview not found.');
    return interview;
  }

  assertInterviewManager(actor: Actor) {
    if (!RECRUITMENT_ROLES.includes(actor.role))
      throw new ForbiddenException('Interview management is not permitted.');
  }

  async assertInterviewPanelists(
    db: DbClient,
    actor: Actor,
    panelistIds: string[],
  ) {
    const users = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND active AND role=ANY($3::text[]) FOR SHARE',
      [actor.tenantId, panelistIds, INTERVIEW_ROLES],
    );
    if (users.length !== panelistIds.length)
      throw new NotFoundException('One or more panelists are unavailable.');
  }

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
