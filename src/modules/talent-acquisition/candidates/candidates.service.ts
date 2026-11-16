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
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const filters = ['c.tenant_id=$1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        filters.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (page.createdFrom) add('c.created_at>=?', page.createdFrom);
      if (page.createdTo) add('c.created_at<=?', page.createdTo);
      if (page.q)
        add('(c.full_name ILIKE ? OR c.email ILIKE ?)', `%${page.q}%`);
      if (page.jobId || page.stage || page.status) {
        const applicationFilters = [
          'a.tenant_id=c.tenant_id',
          'a.candidate_id=c.id',
        ];
        for (const [column, value] of [
          ['a.job_id', page.jobId],
          ['a.stage', page.stage],
          ['j.status', page.status],
        ]) {
          if (value) {
            params.push(value);
            applicationFilters.push(`${column}=$${params.length}`);
          }
        }
        filters.push(
          `EXISTS(SELECT 1 FROM applications a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id WHERE ${applicationFilters.join(' AND ')})`,
        );
      }
      const where = filters.join(' AND ');
      const from = 'candidates c';
      const count = await tx.one<{ total: string }>(
        `SELECT count(*) AS total FROM ${from} WHERE ${where}`,
        params,
      );
      const direction = page.direction === 'asc' ? 'ASC' : 'DESC';
      const sort = page.sort === 'updated_at' ? 'updated_at' : 'created_at';
      const data = await tx.query<Candidate>(
        `SELECT c.* FROM ${from} WHERE ${where} ORDER BY c.${sort} ${direction},c.id ${direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      return {
        data,
        pagination: { limit: page.limit, offset: page.offset },
        total: Number(count!.total),
      };
    });
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
