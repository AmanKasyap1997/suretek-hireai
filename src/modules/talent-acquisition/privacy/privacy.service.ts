import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { Actor } from '../../../shared/actor';
import { ConsentScope } from '../../../shared/enums';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { ObjectStoragePort } from '../../../integrations';

const dormant = `c.updated_at<$3
 AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.tenant_id=c.tenant_id AND a.candidate_id=c.id AND (a.updated_at>=$3 OR a.stage NOT IN ('REJECTED','HIRED')))
 AND NOT EXISTS(SELECT 1 FROM employees e WHERE e.tenant_id=c.tenant_id AND e.candidate_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM consents evidence WHERE evidence.tenant_id=c.tenant_id AND evidence.candidate_id=c.id AND evidence.created_at>=$3)`;
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: DbService,
    private readonly storage: ObjectStoragePort,
  ) {}
  private authorize(actor: Actor) {
    if (!ADMIN_ROLES.includes(actor.role)) throw new ForbiddenException();
  }
  private async revoke(tx: DbClient, actor: Actor, id: string) {
    for (const scope of Object.values(ConsentScope))
      await tx.query(
        `INSERT INTO consents(tenant_id,candidate_id,scope,granted,source,captured_by) VALUES($1,$2,$3,false,'candidate-erasure',$4)`,
        [actor.tenantId, id, scope, actor.userId],
      );
    await tx.query(
      `UPDATE call_requests cr SET status='CANCELLED' FROM applications a WHERE cr.tenant_id=$1 AND a.tenant_id=cr.tenant_id AND a.id=cr.application_id AND a.candidate_id=$2 AND cr.status='PLANNED'`,
      [actor.tenantId, id],
    );
  }
  async erase(actor: Actor, id: string, cutoff?: Date) {
    this.authorize(actor);
    const eligible = await this.db.transaction(async (tx) => {
      const candidate = await tx.one<{ erased_at: Date | null }>(
        'SELECT erased_at FROM candidates WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
        [actor.tenantId, id],
      );
      if (!candidate) throw new NotFoundException('Candidate not found');
      if (
        !candidate.erased_at &&
        cutoff &&
        !(await tx.one(
          `SELECT id FROM candidates c WHERE c.tenant_id=$1 AND c.id=$2 AND ${dormant}`,
          [actor.tenantId, id, cutoff],
        ))
      )
        return false;
      if (!candidate.erased_at) {
        await tx.query(
          `UPDATE candidates SET full_name='Erased candidate',email='erased-'||id::text||'@invalid.example',phone=NULL,erased_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [actor.tenantId, id],
        );
        await tx.query(
          "UPDATE candidate_documents SET original_name='erased-document' WHERE tenant_id=$1 AND candidate_id=$2",
          [actor.tenantId, id],
        );
        await tx.query(
          'DELETE FROM application_details d USING applications a WHERE d.tenant_id=$1 AND a.tenant_id=d.tenant_id AND a.id=d.application_id AND a.candidate_id=$2',
          [actor.tenantId, id],
        );
        // AI screenings quote the resume, so they go with it.
        await tx.query(
          'DELETE FROM application_screenings s USING applications a WHERE s.tenant_id=$1 AND a.tenant_id=s.tenant_id AND a.id=s.application_id AND a.candidate_id=$2',
          [actor.tenantId, id],
        );
        await this.revoke(tx, actor, id);
        await audit(tx, actor, 'candidate.erased', 'candidate', id, {
          reason: cutoff ? 'retention' : 'staff-request',
        });
      }
      return true;
    });
    if (!eligible) return { id, erased: false, documentsPending: 0 };
    // Commit the tombstone first. Storage failures leave inaccessible documents for retry.
    return this.db.transaction(async (tx) => {
      await tx.query(
        'SELECT id FROM candidates WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
        [actor.tenantId, id],
      );
      const documents = await tx.query<{
        id: string;
        object_key: string;
        storage_version: string | null;
      }>(
        'SELECT id,object_key,storage_version FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2',
        [actor.tenantId, id],
      );
      let pending = 0;
      for (const document of documents) {
        try {
          await this.storage.delete(
            document.object_key,
            document.storage_version ?? undefined,
          );
        } catch {
          pending++;
          continue;
        }
        await tx.query(
          'DELETE FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2 AND id=$3',
          [actor.tenantId, id, document.id],
        );
        await audit(
          tx,
          actor,
          'candidate.document_erased',
          'candidate_document',
          document.id,
          { candidateId: id },
        );
      }
      return { id, erased: true, documentsPending: pending };
    });
  }
  async retain(actor: Actor, limit = 100, dryRun = false) {
    this.authorize(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Retention limit must be 1–1000');
    const c = readConfig();
    const global = await this.db.one(
      "SELECT value FROM platform_settings WHERE key='defaults'",
    );
    const cutoff = new Date(
      Date.now() -
        (global?.value.retention_days ?? c.CANDIDATE_RETENTION_DAYS) * 86400000,
    );
    if (!dryRun)
      await this.db.query(
        "DELETE FROM public_intake_limits WHERE tenant_id=$1 AND window_start<now()-($2::int*2)*interval '1 second'",
        [actor.tenantId, c.INTAKE_WINDOW_SECONDS],
      );
    const rows = await this.db.query<{ id: string }>(
      `SELECT c.id FROM candidates c WHERE c.tenant_id=$1 AND ((c.erased_at IS NOT NULL AND EXISTS(SELECT 1 FROM candidate_documents d WHERE d.tenant_id=c.tenant_id AND d.candidate_id=c.id)) OR (c.erased_at IS NULL AND ${dormant.replaceAll('$3', '$2')})) ORDER BY c.updated_at,c.id LIMIT $3`,
      [actor.tenantId, cutoff, limit],
    );
    const results = [];
    if (!dryRun)
      for (const row of rows)
        results.push(await this.erase(actor, row.id, cutoff));
    return {
      dryRun,
      eligible: rows.length,
      erased: results.filter((row) => row.erased).length,
      documentsPending: results.reduce(
        (sum, row) => sum + row.documentsPending,
        0,
      ),
    };
  }
}
