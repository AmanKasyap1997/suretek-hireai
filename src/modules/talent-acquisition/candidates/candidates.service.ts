import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import { CandidateInput, Pagination } from './candidates.schemas';

export interface Candidate {
  id: string;
  full_name: string;
  email: string;
}

@Injectable()
export class CandidatesService {
  constructor(private readonly db: DbService) {}

  async createCandidate(actor: Actor, input: CandidateInput) {
    return this.db.transaction(async (tx) => {
      const candidate = await tx.one<Candidate>(
        `INSERT INTO candidates (tenant_id,full_name,email,phone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [actor.tenantId, input.fullName, input.email, input.phone ?? null],
      );
      await audit(tx, actor, 'candidate.created', 'candidate', candidate!.id);
      return candidate;
    });
  }

  async listCandidates(actor: Actor, page: Pagination) {
    const data = await this.db.query<Candidate>(
      `SELECT * FROM candidates WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getCandidate(actor: Actor, id: string) {
    const row = await this.db.one<Candidate>(
      'SELECT * FROM candidates WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Candidate not found.');
    return row;
  }
}
