import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { readConfig } from '../../../platform/config';
import { DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { CallAssessmentService } from '../calling';
import { ScreeningService } from './screening.service';

/** How often to look for work a restart left behind. */
const SWEEP_MS = 60_000;

/**
 * Resume screenings and call assessments run from in-memory queues, so a
 * restart drops what was waiting or running. Shortly after start, and then
 * every minute, this picks them up again, so the automatic hiring steps
 * (shortlist, call, interview) don't stop for those candidates. Calls
 * themselves are queued in the database and need no recovery.
 */
@Injectable()
export class WorkRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('WorkRecovery');
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly screening: ScreeningService,
    private readonly assessments: CallAssessmentService,
    private readonly host: HttpAdapterHost,
  ) {}

  onApplicationBootstrap() {
    // Only the API process; never in tests, which sweep when they want to.
    if (!this.host.httpAdapter || readConfig().NODE_ENV === 'test') return;
    this.timers = [
      setTimeout(() => void this.sweep(), 5_000),
      setInterval(() => void this.sweep(), SWEEP_MS),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onApplicationShutdown() {
    for (const timer of this.timers) clearTimeout(timer);
  }

  /** One pass over every organization. */
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      // Organizations are only visible one at a time (RLS): a narrow
      // function lists their ids.
      const tenants = await this.db.query<{ id: string }>(
        'SELECT recovery_organizations($1) AS id',
        [10000],
      );
      for (const { id } of tenants)
        try {
          await runWithTenant(id, async () => {
            await this.screening.recover(id);
            await this.assessments.recover(id);
          });
        } catch (error) {
          this.logger.warn(
            `Couldn’t recover an organization’s work (${String(error)})`,
          );
        }
    } finally {
      this.running = false;
    }
  }
}
