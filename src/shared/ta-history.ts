import { DbClient } from '../platform/database/db.service';
import { EvidenceActor } from './actor';
import { ApplicationStage } from './enums';
export async function stageEvent(
  tx: DbClient,
  actor: EvidenceActor,
  id: string,
  from: ApplicationStage | null,
  to: ApplicationStage,
  reason?: string,
  note?: string,
) {
  await tx.query(
    `INSERT INTO application_stage_events(tenant_id,application_id,from_stage,to_stage,reason_code,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [actor.tenantId, id, from, to, reason ?? null, note ?? null, actor.userId],
  );
}
