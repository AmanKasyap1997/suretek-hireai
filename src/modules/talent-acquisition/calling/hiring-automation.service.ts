import { HttpException, Injectable, Logger } from '@nestjs/common';
import { audit } from '../../../platform/audit/audit';
import { DbService } from '../../../platform/database/db.service';
import { ApplicationStage, CallLanguage } from '../../../shared/enums';
import { stageEvent } from '../../../shared/ta-history';
import { aiSettings } from '../../organization-integrations/organization-ai';
import { interviewSetup } from '../jobs';
import { CallingClock } from './calling.clock';
import { planCallRequest } from './calling.service';

/**
 * The automatic hiring steps an HR Admin turns on (Integrations → AI hiring
 * tools): candidates move forward on a high enough score, and HireAI calls
 * them. Nobody is ever rejected automatically, and every step is in the
 * application's history and the audit log.
 */
@Injectable()
export class HiringAutomationService {
  private readonly logger = new Logger('HiringAutomation');

  constructor(
    private readonly db: DbService,
    private readonly clock: CallingClock,
  ) {}

  /**
   * After a resume screening: shortlist an applicant who scored at least the
   * organization's score (and has every must-have), then call them.
   */
  async screened(
    tenantId: string,
    applicationId: string,
    screening: { id: string; score: number; missingMustHave: boolean },
  ) {
    try {
      const settings = await aiSettings(this.db, tenantId);
      const min = settings.autoShortlistScore;
      if (min === null || screening.missingMustHave || screening.score < min)
        return;
      const moved = await this.advance(
        tenantId,
        applicationId,
        ApplicationStage.APPLIED,
        ApplicationStage.SHORTLISTED,
        `Automatic: resume score ${screening.score} (shortlisted at ${min} or more)`,
        { score: screening.score, threshold: min, screeningId: screening.id },
      );
      if (moved && settings.autoCallShortlisted && settings.callingEnabled)
        await this.call(
          tenantId,
          applicationId,
          'SCREENING',
          `auto:screening:${screening.id}`,
        );
    } catch (error) {
      this.logger.warn(`Automatic shortlisting failed (${String(error)})`);
    }
  }

  /**
   * After a screening call's answers are assessed: move a candidate who
   * scored at least the organization's score (with no deal-breaker answer)
   * to interviews, and call them to book one.
   */
  async callAssessed(
    tenantId: string,
    callRequestId: string,
    assessment: { score: number | null; deal_breaker: boolean },
  ) {
    try {
      const request = await this.db.one<{
        application_id: string;
        purpose: string;
        interview_setup: unknown;
      }>(
        `SELECT cr.application_id,cr.purpose,j.interview_setup FROM call_requests cr
         JOIN applications a ON a.tenant_id=cr.tenant_id AND a.id=cr.application_id
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         WHERE cr.tenant_id=$1 AND cr.id=$2`,
        [tenantId, callRequestId],
      );
      if (!request || request.purpose !== 'SCREENING') return;
      const settings = await aiSettings(this.db, tenantId);
      const min = settings.autoInterviewScore;
      if (
        min === null ||
        assessment.score === null ||
        assessment.deal_breaker ||
        assessment.score < min
      )
        return;
      const moved = await this.advance(
        tenantId,
        request.application_id,
        ApplicationStage.SHORTLISTED,
        ApplicationStage.INTERVIEW,
        `Automatic: call score ${assessment.score} (moved to interviews at ${min} or more)`,
        { score: assessment.score, threshold: min, callRequestId },
      );
      if (!moved) return;
      if (!interviewSetup(request.interview_setup)) {
        await this.skipped(
          tenantId,
          request.application_id,
          'SCHEDULING',
          'The job has no interview booking set up.',
        );
        return;
      }
      if (settings.callingEnabled)
        await this.call(
          tenantId,
          request.application_id,
          'SCHEDULING',
          `auto:scheduling:${callRequestId}`,
        );
    } catch (error) {
      this.logger.warn(
        `Automatic move to interviews failed (${String(error)})`,
      );
    }
  }

  /** Moves an application on, if it's still at `from`. */
  private advance(
    tenantId: string,
    applicationId: string,
    from: ApplicationStage,
    to: ApplicationStage,
    note: string,
    details: Record<string, unknown>,
  ) {
    const system = { tenantId, userId: null };
    return this.db.transaction(async (tx) => {
      const moved = await tx.one(
        'UPDATE applications SET stage=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND stage=$3 RETURNING id',
        [tenantId, applicationId, from, to],
      );
      if (!moved) return false;
      await stageEvent(tx, system, applicationId, from, to, undefined, note);
      await audit(
        tx,
        system,
        to === ApplicationStage.SHORTLISTED
          ? 'application.auto_shortlisted'
          : 'application.auto_interview',
        'application',
        applicationId,
        details,
      );
      return true;
    });
  }

  /** Plans an AI call as HireAI, after the usual checks (consent etc.). */
  private async call(
    tenantId: string,
    applicationId: string,
    purpose: 'SCREENING' | 'SCHEDULING',
    idempotencyKey: string,
  ) {
    try {
      await this.db.transaction((tx) =>
        planCallRequest(
          tx,
          this.clock.now(),
          { tenantId, userId: null },
          {
            applicationId,
            language: CallLanguage.EN,
            // As far as the candidate's consent goes.
            recording: true,
            transcription: true,
            idempotencyKey,
          },
          { optionalConsents: true, purpose },
        ),
      );
    } catch (error) {
      await this.skipped(
        tenantId,
        applicationId,
        purpose,
        error instanceof HttpException ? error.message : 'Unexpected error',
      );
    }
  }

  /** Records why HireAI didn't place a call it would have. */
  private async skipped(
    tenantId: string,
    applicationId: string,
    purpose: string,
    reason: string,
  ) {
    this.logger.warn(
      `An automatic ${purpose.toLowerCase()} call wasn't planned: ${reason}`,
    );
    await audit(
      this.db,
      { tenantId, userId: null },
      'call.auto_not_planned',
      'application',
      applicationId,
      { purpose, reason: reason.slice(0, 200) },
    );
  }
}
