import { Injectable, NotFoundException } from '@nestjs/common';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { ApplicationStage } from '../../../shared/enums';
import { RecruitmentReportQuery } from './reports.schemas';

interface FunnelRow {
  jobId: string;
  jobTitle: string;
  stage: ApplicationStage;
  applicationCount: number;
}

interface DwellRow extends FunnelRow {
  visitCount: number;
  totalSeconds: number;
  averageSeconds: number;
}

interface HireRow {
  jobId: string;
  jobTitle: string;
  hireCount: number;
  totalSeconds: number;
  averageSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  missingApplied: number;
  invalidOrder: number;
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  private async assertJob(
    tx: DbClient,
    actor: Actor,
    query: RecruitmentReportQuery,
  ): Promise<void> {
    if (
      query.jobId &&
      !(await tx.one('SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        query.jobId,
      ]))
    ) {
      throw new NotFoundException('Job not found.');
    }
  }

  private metadata(query: RecruitmentReportQuery) {
    return {
      period: { from: query.from, to: query.to },
      asOf: query.asOf,
    };
  }

  async funnel(actor: Actor, query: RecruitmentReportQuery) {
    return this.db.transaction(async (tx) => {
      await this.assertJob(tx, actor, query);
      const data = await tx.query<FunnelRow>(
        `SELECT a.job_id AS "jobId",j.title AS "jobTitle",e.to_stage AS stage,
           count(DISTINCT e.application_id)::int AS "applicationCount"
         FROM application_stage_events e
         JOIN applications a ON a.tenant_id=e.tenant_id AND a.id=e.application_id
         JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         WHERE e.tenant_id=$1 AND a.tenant_id=$1 AND j.tenant_id=$1
           AND ($2::uuid IS NULL OR a.job_id=$2)
           AND e.created_at >= $3::timestamptz AND e.created_at < $4::timestamptz
         GROUP BY a.job_id,j.title,e.to_stage
         ORDER BY a.job_id,array_position($5::text[],e.to_stage)`,
        [
          actor.tenantId,
          query.jobId ?? null,
          query.from,
          query.observedTo,
          Object.values(ApplicationStage),
        ],
      );
      return { ...this.metadata(query), data };
    });
  }

  async timeInStage(actor: Actor, query: RecruitmentReportQuery) {
    return this.db.transaction(async (tx) => {
      await this.assertJob(tx, actor, query);
      const data = await tx.query<DwellRow>(
        `WITH timeline AS (
           SELECT a.job_id,j.title AS job_title,e.application_id,e.to_stage AS stage,
             e.created_at AS entered_at,
             lead(e.created_at) OVER (
               PARTITION BY e.application_id ORDER BY e.created_at,e.id
             ) AS next_at
           FROM application_stage_events e
           JOIN applications a ON a.tenant_id=e.tenant_id AND a.id=e.application_id
           JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
           WHERE e.tenant_id=$1 AND a.tenant_id=$1 AND j.tenant_id=$1
             AND ($2::uuid IS NULL OR a.job_id=$2)
             AND e.created_at < $4::timestamptz
         ), stage_visits AS (
           SELECT job_id,job_title,application_id,stage,
             greatest(entered_at,$3::timestamptz) AS started_at,
             least(coalesce(next_at,$4::timestamptz),$4::timestamptz) AS ended_at
           FROM timeline WHERE NOT (stage=ANY($5::text[]))
         ), durations AS (
           SELECT job_id,job_title,application_id,stage,
             extract(epoch FROM ended_at-started_at)::double precision AS seconds
           FROM stage_visits WHERE ended_at>started_at
         )
         SELECT job_id AS "jobId",job_title AS "jobTitle",stage,
           count(DISTINCT application_id)::int AS "applicationCount",
           count(*)::int AS "visitCount",
           sum(seconds)::double precision AS "totalSeconds",
           avg(seconds)::double precision AS "averageSeconds"
         FROM durations GROUP BY job_id,job_title,stage
         ORDER BY job_id,array_position($6::text[],stage)`,
        [
          actor.tenantId,
          query.jobId ?? null,
          query.from,
          query.observedTo,
          [ApplicationStage.HIRED, ApplicationStage.REJECTED],
          Object.values(ApplicationStage),
        ],
      );
      return { ...this.metadata(query), data };
    });
  }

  async timeToHire(actor: Actor, query: RecruitmentReportQuery) {
    return this.db.transaction(async (tx) => {
      await this.assertJob(tx, actor, query);
      const rows = await tx.query<HireRow>(
        `WITH histories AS (
           SELECT a.id AS application_id,a.job_id,j.title AS job_title,
             min(e.created_at) FILTER (WHERE e.to_stage=$5) AS applied_at,
             min(e.created_at) FILTER (WHERE e.to_stage=$6) AS hired_at
           FROM application_stage_events e
           JOIN applications a ON a.tenant_id=e.tenant_id AND a.id=e.application_id
           JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
           WHERE e.tenant_id=$1 AND a.tenant_id=$1 AND j.tenant_id=$1
             AND ($2::uuid IS NULL OR a.job_id=$2)
           GROUP BY a.id,a.job_id,j.title
         ), hires AS (
           SELECT *,extract(epoch FROM hired_at-applied_at)::double precision AS seconds
           FROM histories
           WHERE hired_at >= $3::timestamptz AND hired_at < $4::timestamptz
         )
         SELECT job_id AS "jobId",job_title AS "jobTitle",
           (count(*) FILTER (WHERE applied_at<=hired_at))::int AS "hireCount",
           coalesce(sum(seconds) FILTER (WHERE applied_at<=hired_at),0)::double precision AS "totalSeconds",
           (avg(seconds) FILTER (WHERE applied_at<=hired_at))::double precision AS "averageSeconds",
           (min(seconds) FILTER (WHERE applied_at<=hired_at))::double precision AS "minSeconds",
           (max(seconds) FILTER (WHERE applied_at<=hired_at))::double precision AS "maxSeconds",
           (count(*) FILTER (WHERE applied_at IS NULL))::int AS "missingApplied",
           (count(*) FILTER (WHERE applied_at>hired_at))::int AS "invalidOrder"
         FROM hires GROUP BY job_id,job_title ORDER BY job_id`,
        [
          actor.tenantId,
          query.jobId ?? null,
          query.from,
          query.observedTo,
          ApplicationStage.APPLIED,
          ApplicationStage.HIRED,
        ],
      );
      return {
        ...this.metadata(query),
        data: rows
          .filter((row) => row.hireCount > 0)
          .map((row) => ({
            jobId: row.jobId,
            jobTitle: row.jobTitle,
            hireCount: row.hireCount,
            totalSeconds: row.totalSeconds,
            averageSeconds: row.averageSeconds!,
            minSeconds: row.minSeconds!,
            maxSeconds: row.maxSeconds!,
          })),
        excludedHiresMissingApplied: rows.reduce(
          (count, row) => count + row.missingApplied,
          0,
        ),
        excludedHiresInvalidOrder: rows.reduce(
          (count, row) => count + row.invalidOrder,
          0,
        ),
      };
    });
  }
}
