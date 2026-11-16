import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbClient } from '../../platform/database/db.service';
import { Actor } from '../../shared/actor';

export interface ProvisionedEmployee {
  id: string;
}

export interface AcceptedOfferProvisioningInput {
  sourceOfferId: string;
  candidateId: string;
  fullName: string;
  email: string;
  joiningDate: string;
  annualCtc: string;
  currency: string;
}

/** Uses the caller's transaction so hiring retains its original lock order. */
@Injectable()
export class HrProvisioningService {
  lookupBySourceOffer(tx: DbClient, actor: Actor, sourceOfferId: string) {
    return tx.one<ProvisionedEmployee>(
      'SELECT * FROM employees WHERE tenant_id=$1 AND source_offer_id=$2',
      [actor.tenantId, sourceOfferId],
    );
  }

  async provisionFromAcceptedOffer(
    tx: DbClient,
    actor: Actor,
    input: AcceptedOfferProvisioningInput,
  ): Promise<ProvisionedEmployee> {
    const existing = await tx.one<ProvisionedEmployee>(
      'SELECT id FROM employees WHERE tenant_id=$1 AND candidate_id=$2',
      [actor.tenantId, input.candidateId],
    );
    if (existing)
      throw new ConflictException(
        'An employee record already exists for this candidate.',
      );
    const employeeId = randomUUID();
    const employee = await tx.one<ProvisionedEmployee>(
      `INSERT INTO employees (id,tenant_id,candidate_id,source_offer_id,employee_code,full_name,email,joining_date,annual_ctc,currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        employeeId,
        actor.tenantId,
        input.candidateId,
        input.sourceOfferId,
        `EMP-${employeeId.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        input.fullName,
        input.email,
        input.joiningDate,
        input.annualCtc,
        input.currency,
      ],
    );
    await tx.query(
      `INSERT INTO onboarding_tasks (tenant_id,employee_id,title) VALUES ($1,$2,'Collect joining documents'),
         ($1,$2,'Provision work access'),($1,$2,'Complete HR induction')`,
      [actor.tenantId, employeeId],
    );
    return employee!;
  }
}
