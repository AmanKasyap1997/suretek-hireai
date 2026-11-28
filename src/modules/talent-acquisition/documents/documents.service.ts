import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { Actor, EvidenceActor } from '../../../shared/actor';
import { DocumentScanStatus, Role } from '../../../shared/enums';
import {
  StoredObject,
  ObjectStoragePort,
  MalwareScanPort,
  validateResume,
} from '../../../integrations';

export interface ResumeUpload {
  originalname: string;
  buffer: Buffer;
}
interface DocumentRow {
  id: string;
  object_key: string;
  storage_version: string | null;
  original_name: string;
  content_type: string;
  sha256: string;
  scan_status: DocumentScanStatus;
}
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  constructor(
    private readonly db: DbService,
    private readonly storage: ObjectStoragePort,
    private readonly scanner: MalwareScanPort,
  ) {}
  async write(
    tx: DbClient,
    actor: EvidenceActor,
    candidateId: string,
    file: ResumeUpload,
    stored: (object: StoredObject) => void,
    /** The application this resume was sent with; none for staff uploads. */
    applicationId: string | null = null,
  ) {
    const cfg = readConfig();
    const format = validateResume(
      file.originalname,
      file.buffer,
      cfg.RESUME_MAX_BYTES,
    );
    const id = randomUUID(),
      key = `${actor.tenantId}/${id}`;
    let status: DocumentScanStatus;
    try {
      status = await this.scanner.scan(file.buffer);
    } catch {
      status = DocumentScanStatus.FAILED;
    }
    if (!Object.values(DocumentScanStatus).includes(status))
      status = DocumentScanStatus.FAILED;
    const versionId = await this.storage.put(
      key,
      file.buffer,
      format.contentType,
    );
    stored({ key, versionId });
    const row = await tx.one(
      `INSERT INTO candidate_documents(id,tenant_id,candidate_id,object_key,original_name,content_type,byte_size,sha256,scan_status,storage_version,application_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,original_name,content_type,byte_size,sha256,scan_status,created_at,application_id`,
      [
        id,
        actor.tenantId,
        candidateId,
        key,
        format.filename,
        format.contentType,
        file.buffer.length,
        createHash('sha256').update(file.buffer).digest('hex'),
        status,
        versionId ?? null,
        applicationId,
      ],
    );
    await tx.query(
      'UPDATE candidates SET updated_at=now() WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, candidateId],
    );
    await audit(
      tx,
      actor,
      'candidate.document_uploaded',
      'candidate_document',
      id,
      { candidateId, scanStatus: status },
    );
    if (status !== DocumentScanStatus.PENDING) {
      await tx.query(
        'UPDATE candidate_documents SET scanned_at=clock_timestamp(),scan_attempts=1,scan_error=$3 WHERE tenant_id=$1 AND id=$2',
        [
          actor.tenantId,
          id,
          status === DocumentScanStatus.FAILED ? 'SCANNER_FAILED' : null,
        ],
      );
      if (status === DocumentScanStatus.INFECTED)
        await audit(
          tx,
          actor,
          'candidate.document_quarantined',
          'candidate_document',
          id,
        );
    }
    return row;
  }
  async cleanup(keys: StoredObject[]) {
    for (const key of keys)
      try {
        await this.storage.delete(key.key, key.versionId);
      } catch {
        this.logger.warn(
          'Pre-commit resume cleanup failed; reconcile private storage inventory',
        );
      }
  }
  async upload(actor: Actor, candidateId: string, file: ResumeUpload) {
    const keys: StoredObject[] = [];
    try {
      return await this.db.transaction(async (tx) => {
        await this.candidate(tx, actor, candidateId);
        return this.write(tx, actor, candidateId, file, (key) =>
          keys.push(key),
        );
      });
    } catch (error) {
      await this.cleanup(keys);
      throw error;
    }
  }
  private async candidate(tx: DbClient, actor: Actor, candidateId: string) {
    // A hiring manager: only someone who applied to one of their jobs.
    const manager = actor.role === Role.HIRING_MANAGER;
    const candidate = await tx.one(
      `SELECT c.id FROM candidates c WHERE c.tenant_id=$1 AND c.id=$2 AND c.erased_at IS NULL${
        manager
          ? ` AND EXISTS (SELECT 1 FROM applications a JOIN job_assignments ja
               ON ja.tenant_id=a.tenant_id AND ja.job_id=a.job_id AND ja.user_id=$3 AND ja.role='HIRING_MANAGER'
               WHERE a.tenant_id=c.tenant_id AND a.candidate_id=c.id)`
          : ''
      } FOR NO KEY UPDATE OF c`,
      manager
        ? [actor.tenantId, candidateId, actor.userId]
        : [actor.tenantId, candidateId],
    );
    if (!candidate) throw new NotFoundException('Candidate not found');
  }
  async list(actor: Actor, candidateId: string) {
    return this.db.transaction(async (tx) => {
      await this.candidate(tx, actor, candidateId);
      return tx.query(
        'SELECT id,original_name,content_type,byte_size,sha256,scan_status,created_at FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY created_at DESC,id',
        [actor.tenantId, candidateId],
      );
    });
  }
  async download(actor: Actor, candidateId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await this.candidate(tx, actor, candidateId);
      const row = await tx.one<DocumentRow>(
        'SELECT id,object_key,storage_version,original_name,content_type,sha256,scan_status FROM candidate_documents WHERE tenant_id=$1 AND candidate_id=$2 AND id=$3',
        [actor.tenantId, candidateId, id],
      );
      if (!row) throw new NotFoundException('Document not found');
      if (row.scan_status !== DocumentScanStatus.CLEAN)
        throw new ConflictException('Document is not cleared for download');
      let bytes: Buffer;
      try {
        bytes = await this.storage.get(
          row.object_key,
          row.storage_version ?? undefined,
        );
      } catch {
        throw new ServiceUnavailableException(
          'Document storage is unavailable',
        );
      }
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
        throw new ConflictException('Document integrity check failed');
      await audit(
        tx,
        actor,
        'candidate.document_downloaded',
        'candidate_document',
        id,
        { candidateId },
      );
      return {
        bytes,
        filename: row.original_name,
        contentType: row.content_type,
      };
    });
  }
}
