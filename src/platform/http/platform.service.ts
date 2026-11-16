import { Injectable } from '@nestjs/common';
import { Actor } from '../../shared/actor';
import { DbService } from '../database/db.service';

@Injectable()
export class PlatformService {
  constructor(private readonly db: DbService) {}

  async summary(actor: Actor) {
    return {
      applicationsByStage: await this.db.query(
        'SELECT stage,count(*)::int AS count FROM applications WHERE tenant_id=$1 GROUP BY stage ORDER BY stage',
        [actor.tenantId],
      ),
      jobsByStatus: await this.db.query(
        'SELECT status,count(*)::int AS count FROM jobs WHERE tenant_id=$1 GROUP BY status ORDER BY status',
        [actor.tenantId],
      ),
    };
  }

  async audit(actor: Actor, p: { limit: number; offset: number }) {
    return {
      data: await this.db.query(
        'SELECT id,actor_id,action,entity_type,entity_id,metadata,created_at FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
}
