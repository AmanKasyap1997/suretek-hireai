import { tenantContext } from '../database/tenant-context';
import { EvidenceActor } from '../../shared/actor';
import { DbClient } from '../database/db.service';
export async function audit(
  db: DbClient,
  actor: EvidenceActor,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO audit_events (tenant_id,actor_id,action,entity_type,entity_id,metadata,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      actor.tenantId,
      actor.userId,
      action,
      entityType,
      entityId,
      JSON.stringify(metadata),
      tenantContext.getStore()?.ip ?? null,
      tenantContext.getStore()?.userAgent ?? null,
    ],
  );
}
