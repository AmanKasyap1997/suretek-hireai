import {
  JobsService,
  ApplicationsService,
  OffersService,
} from '../src/modules/talent-acquisition';
import { ConflictException } from '@nestjs/common';
import { HrProvisioningService } from '../src/modules/hr';
import { DbService } from '../src/platform/database/db.service';
import { AccessPolicy } from '../src/shared/ta-policy';
import {
  ApplicationStage,
  JobStatus,
  OfferStatus,
  Role,
} from '../src/shared/enums';
const actor = { tenantId: 'tenant', userId: 'maker', role: Role.HR_ADMIN };
function database(row: object) {
  const one = jest.fn().mockResolvedValue(row);
  const query = jest.fn().mockResolvedValue([]);
  const db = {
    one,
    query,
    transaction: async (fn: (tx: unknown) => unknown) => fn({ one, query }),
  } as unknown as DbService;
  return { db, one, query };
}
it.each([
  JobStatus.DRAFT,
  JobStatus.APPROVED,
  JobStatus.PUBLISHED,
  JobStatus.CLOSED,
])('prevents reopening or reapproving a %s job', async (status) => {
  const { db, one, query } = database({ id: 'job', status });
  await expect(
    new JobsService(db, new AccessPolicy()).transitionJob(
      actor,
      'job',
      JobStatus.DRAFT,
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(one).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
});
it.each([
  ApplicationStage.REJECTED,
  ApplicationStage.HIRED,
  ApplicationStage.OFFER,
])(
  'prevents staff edits to a terminal or offer-managed application in %s',
  async (stage) => {
    const { db, one, query } = database({ id: 'app', job_id: 'job', stage });
    await expect(
      new ApplicationsService(db, new AccessPolicy()).changeStage(
        actor,
        'app',
        { stage: ApplicationStage.SHORTLISTED },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(one).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
  },
);
it.each([
  OfferStatus.ACCEPTED,
  OfferStatus.DECLINED,
  OfferStatus.WITHDRAWN,
  OfferStatus.EXPIRED,
])('prevents modifying a completed %s offer', async (status) => {
  const { db, one, query } = database({ id: 'offer', status });
  const service = new OffersService(db, {} as HrProvisioningService);
  await expect(
    service.terminate(actor, 'offer', OfferStatus.WITHDRAWN),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(one).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
});
