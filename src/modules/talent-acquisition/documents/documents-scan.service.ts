import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../../../platform/database/db.service';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { Actor } from '../../../shared/actor';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { DocumentScanStatus as Status } from '../../../shared/enums';
import { MalwareScanPort, ObjectStoragePort } from '../../../integrations';
@Injectable()
export class DocumentsScanService {
  constructor(
    private readonly db: DbService,
    private readonly scanner: MalwareScanPort,
    private readonly storage: ObjectStoragePort,
  ) {}
  async sweep(actor: Actor, limit = 100) {
    if (!ADMIN_ROLES.includes(actor.role)) throw new ForbiddenException();
    const cfg = readConfig();
    if (cfg.MALWARE_SCANNER !== 'clamav')
      throw new Error('documents:scan requires MALWARE_SCANNER=clamav');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid scan limit');
    const seen: string[] = [];
    const counts = { scanned: 0, clean: 0, infected: 0, failed: 0 };
    for (let i = 0; i < limit; i++) {
      const result = await this.db.transaction(async (tx) => {
        // Candidate before document locks matches erasure/download lock ordering.
        const candidate = await tx.one(
          `SELECT c.id FROM candidates c WHERE c.tenant_id=$1 AND c.erased_at IS NULL AND EXISTS(SELECT 1 FROM candidate_documents d WHERE d.tenant_id=$1 AND d.candidate_id=c.id AND d.scan_status=ANY($2::text[]) AND d.scan_attempts<$3 AND NOT(d.id=ANY($4::uuid[]))) ORDER BY c.id FOR NO KEY UPDATE SKIP LOCKED LIMIT 1`,
          [
            actor.tenantId,
            [Status.PENDING, Status.FAILED, Status.ERROR],
            cfg.DOCUMENT_SCAN_MAX_ATTEMPTS,
            seen,
          ],
        );
        if (!candidate) return;
        const doc = await tx.one(
          `SELECT * FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2 AND scan_status=ANY($3::text[]) AND scan_attempts<$4 AND NOT(id=ANY($5::uuid[])) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [
            actor.tenantId,
            candidate.id,
            [Status.PENDING, Status.FAILED, Status.ERROR],
            cfg.DOCUMENT_SCAN_MAX_ATTEMPTS,
            seen,
          ],
        );
        if (!doc) return;
        let status = Status.FAILED,
          error: string | null = null;
        try {
          const bytes = await this.storage.get(
            doc.object_key,
            doc.storage_version ?? undefined,
          );
          if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256)
            error = 'INTEGRITY_MISMATCH';
          else {
            const scanned = await this.scanner.scan(bytes);
            status = [Status.CLEAN, Status.INFECTED].includes(scanned)
              ? scanned
              : Status.FAILED;
            if (status === Status.FAILED) error = 'SCANNER_FAILED';
          }
        } catch {
          error = 'STORAGE_OR_SCANNER_FAILED';
        }
        await tx.query(
          'UPDATE candidate_documents SET scan_status=$3,scanned_at=clock_timestamp(),scan_attempts=scan_attempts+1,scan_error=$4 WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, doc.id, status, error],
        );
        await audit(
          tx,
          actor,
          status === Status.INFECTED
            ? 'candidate.document_quarantined'
            : 'candidate.document_scanned',
          'candidate_document',
          doc.id,
          { scanStatus: status, attempt: doc.scan_attempts + 1, error },
        );
        return { id: doc.id, status };
      });
      if (!result) break;
      seen.push(result.id);
      counts.scanned++;
      if (result.status === Status.CLEAN) counts.clean++;
      else if (result.status === Status.INFECTED) counts.infected++;
      else counts.failed++;
    }
    return counts;
  }
}
