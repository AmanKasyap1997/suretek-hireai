import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import {
  InterviewStatus,
  ScorecardRecommendation,
} from '../../../shared/enums';
import { AccessPolicy, isScoped } from '../../../shared/ta-policy';
import { SubmitScorecardInput } from './scorecards.schemas';

export interface InterviewScorecard {
  id: string;
  interview_id: string;
  panelist_user_id: string;
  scores: SubmitScorecardInput['scores'];
  recommendation: ScorecardRecommendation;
  notes: string;
  submitted_at: Date;
}

@Injectable()
export class ScorecardsService {
  constructor(
    private readonly db: DbService,
    private readonly policy: AccessPolicy,
  ) {}

  async submit(actor: Actor, interviewId: string, input: SubmitScorecardInput) {
    return this.db.transaction(async (tx) => {
      // Match administrator account changes: tenant before user/evidence locks.
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE', [
        actor.tenantId,
      ]);
      // This also requires panel membership for administrators and recruiters.
      const interview = await this.policy.assertInterview(
        tx,
        actor,
        interviewId,
        {
          requirePanelist: true,
          lock: true,
        },
      );
      if (interview.status === InterviewStatus.CANCELLED) {
        throw new ConflictException(
          'Cancelled interviews cannot receive scorecards',
        );
      }
      const criteria = new Set(
        interview.criteria_snapshot.map((criterion) => criterion.id),
      );
      const supplied = new Set(input.scores.map((score) => score.criterionId));
      if (
        supplied.size !== input.scores.length ||
        criteria.size !== input.scores.length ||
        input.scores.some((score) => !criteria.has(score.criterionId))
      ) {
        throw new BadRequestException(
          'Scores must include each snapshotted interview criterion exactly once',
        );
      }
      const existing = await tx.one<{ id: string }>(
        'SELECT id FROM interview_scorecards WHERE tenant_id=$1 AND interview_id=$2 AND panelist_user_id=$3',
        [actor.tenantId, interviewId, actor.userId],
      );
      if (existing) {
        throw new ConflictException(
          'A scorecard has already been submitted by this panelist',
        );
      }
      const scorecard = await tx.one<InterviewScorecard>(
        `INSERT INTO interview_scorecards (tenant_id,interview_id,panelist_user_id,scores,recommendation,notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id,interview_id,panelist_user_id,scores,recommendation,notes,submitted_at`,
        [
          actor.tenantId,
          interviewId,
          actor.userId,
          JSON.stringify(input.scores),
          input.recommendation,
          input.notes,
        ],
      );
      await audit(
        tx,
        actor,
        'scorecard.submitted',
        'interview_scorecard',
        scorecard!.id,
        { interviewId },
      );
      return scorecard;
    });
  }

  async list(actor: Actor, interviewId: string) {
    return this.db.transaction(async (tx) => {
      await this.policy.assertInterview(tx, actor, interviewId, {
        requirePanelist: isScoped(actor),
      });
      const params: unknown[] = [actor.tenantId, interviewId];
      const ownOnly = isScoped(actor);
      if (ownOnly) params.push(actor.userId);
      return tx.query<InterviewScorecard>(
        `SELECT id,interview_id,panelist_user_id,scores,recommendation,notes,submitted_at
         FROM interview_scorecards WHERE tenant_id=$1 AND interview_id=$2${ownOnly ? ' AND panelist_user_id=$3' : ''}
         ORDER BY submitted_at,id`,
        params,
      );
    });
  }
}
