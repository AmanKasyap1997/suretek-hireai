import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccessPolicy } from '../src/shared/ta-policy';
import { DbClient } from '../src/platform/database/db.service';
import { Role, ApplicationStage } from '../src/shared/enums';
const policy = new AccessPolicy();
const actor = { tenantId: 'tenant', userId: 'user', role: Role.HIRING_MANAGER };
it('uses tenant, job, user and assignment role together for scoped visibility', async () => {
  const one = jest.fn().mockResolvedValue(undefined);
  const db = { one } as unknown as DbClient;
  await expect(policy.assertJob(db, actor, 'job')).rejects.toBeInstanceOf(
    NotFoundException,
  );
  expect(one).toHaveBeenCalledWith(
    expect.stringContaining("assignment.role='HIRING_MANAGER'"),
    ['tenant', 'job', 'user'],
  );
  one.mockResolvedValue({ id: 'job' });
  await expect(policy.assertJob(db, actor, 'job')).resolves.toBeUndefined();
});
it('allows only human shortlist/reject decisions for scoped managers', () => {
  expect(() =>
    policy.assertStage(actor, ApplicationStage.SHORTLISTED),
  ).not.toThrow();
  expect(() =>
    policy.assertStage(actor, ApplicationStage.REJECTED),
  ).not.toThrow();
  for (const stage of [
    ApplicationStage.INTERVIEW,
    ApplicationStage.OFFER,
    ApplicationStage.HIRED,
  ])
    expect(() => policy.assertStage(actor, stage)).toThrow(ForbiddenException);
  for (const stage of Object.values(ApplicationStage))
    expect(() =>
      policy.assertStage({ ...actor, role: Role.INTERVIEWER }, stage),
    ).toThrow(ForbiddenException);
});
