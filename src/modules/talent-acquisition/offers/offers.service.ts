import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../../platform/database/db.service';
import { Actor } from '../../../shared/actor';
import { audit } from '../../../platform/audit/audit';
import { ApplicationStage, OfferStatus } from '../../../shared/enums';
import { OfferInput, Pagination } from './offers.schemas';
import type { Application } from '../applications';
import type { Candidate } from '../candidates';
import { HrProvisioningService } from '../../hr';

export interface Offer {
  id: string;
  application_id: string;
  status: OfferStatus;
  annual_ctc: string;
  currency: string;
  joining_date: string;
}

@Injectable()
export class OffersService {
  constructor(
    private readonly db: DbService,
    private readonly provisioning: HrProvisioningService,
  ) {}

  async createOffer(actor: Actor, input: OfferInput) {
    return this.db.transaction(async (tx) => {
      const app = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, input.applicationId],
      );
      if (!app) throw new NotFoundException('Application not found.');
      const offerEligibleStages: readonly ApplicationStage[] = [
        ApplicationStage.SHORTLISTED,
        ApplicationStage.INTERVIEW,
      ];
      if (!offerEligibleStages.includes(app.stage))
        throw new ConflictException(
          'Shortlist or interview the candidate before drafting an offer.',
        );
      const offer = await tx.one<Offer>(
        `INSERT INTO offers (tenant_id,application_id,annual_ctc,currency,joining_date,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          actor.tenantId,
          input.applicationId,
          input.annualCtc,
          input.currency,
          input.joiningDate,
          actor.userId,
        ],
      );
      await tx.query(
        'UPDATE applications SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, app.id, ApplicationStage.OFFER],
      );
      await audit(tx, actor, 'offer.created', 'offer', offer!.id);
      return offer;
    });
  }

  async listOffers(actor: Actor, page: Pagination) {
    const data = await this.db.query<Offer>(
      'SELECT * FROM offers WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
      [actor.tenantId, page.limit, page.offset],
    );
    return { data, pagination: page };
  }

  async getOffer(actor: Actor, id: string) {
    const row = await this.db.one<Offer>(
      'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Offer not found.');
    return row;
  }

  async approveOffer(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== OfferStatus.DRAFT)
        throw new ConflictException('Only draft offers can be approved.');
      const updated = await tx.one<Offer>(
        `UPDATE offers SET status=$4,approved_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, actor.userId, OfferStatus.APPROVED],
      );
      await audit(tx, actor, 'offer.approved', 'offer', id);
      return updated;
    });
  }

  async acceptOffer(actor: Actor, id: string, acceptanceReference: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== OfferStatus.APPROVED)
        throw new ConflictException(
          'Only approved offers can have acceptance recorded.',
        );
      const updated = await tx.one<Offer>(
        `UPDATE offers SET status=$4,accepted_at=now(),acceptance_reference=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [actor.tenantId, id, acceptanceReference, OfferStatus.ACCEPTED],
      );
      // The reference is evidence metadata recorded by HR, not an electronic signature.
      await audit(tx, actor, 'offer.acceptance_recorded', 'offer', id);
      return updated;
    });
  }

  async hire(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const offer = await tx.one<Offer>(
        'SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!offer) throw new NotFoundException('Offer not found.');
      if (offer.status !== OfferStatus.ACCEPTED)
        throw new ConflictException(
          'Record candidate acceptance before hiring.',
        );
      // Locking the offer serializes retries and concurrent requests for the same offer.
      const previous = await this.provisioning.lookupBySourceOffer(
        tx,
        actor,
        id,
      );
      if (previous) return previous;
      const app = await tx.one<Application>(
        'SELECT * FROM applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, offer.application_id],
      );
      if (!app || app.stage !== ApplicationStage.OFFER)
        throw new ConflictException('Application is not in the offer stage.');
      const candidate = await tx.one<Candidate>(
        'SELECT * FROM candidates WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, app.candidate_id],
      );
      if (!candidate) throw new NotFoundException('Candidate not found.');
      const employee = await this.provisioning.provisionFromAcceptedOffer(
        tx,
        actor,
        {
          sourceOfferId: id,
          candidateId: candidate.id,
          fullName: candidate.full_name,
          email: candidate.email,
          joiningDate: offer.joining_date,
          annualCtc: offer.annual_ctc,
          currency: offer.currency,
        },
      );
      await tx.query(
        `UPDATE applications SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [actor.tenantId, app.id, ApplicationStage.HIRED],
      );
      await audit(
        tx,
        actor,
        'employee.created_from_offer',
        'employee',
        employee.id,
        { offerId: id, applicationId: app.id },
      );
      return employee;
    });
  }
}
