import {
  CallAssessmentService,
  ScreeningService,
  WorkRecoveryService,
} from '../src/modules/talent-acquisition';
import { DbService } from '../src/platform/database/db.service';
import { OrganizationAiService } from '../src/modules/organization-integrations/organization-ai';
import { HiringAutomationService } from '../src/modules/talent-acquisition';
import { HttpAdapterHost } from '@nestjs/core';

const org1 = '11111111-1111-4111-8111-111111111111';
const org2 = '22222222-2222-4222-8222-222222222222';

describe('work a restart left behind', () => {
  it('sweeps every organization, and one failing doesn’t stop the rest', async () => {
    const db = {
      query: jest.fn(async () => [{ id: org1 }, { id: org2 }]),
    } as unknown as DbService;
    const screening = {
      recover: jest
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(undefined),
    };
    const assessments = { recover: jest.fn(async () => undefined) };
    const recovery = new WorkRecoveryService(
      db,
      screening as unknown as ScreeningService,
      assessments as unknown as CallAssessmentService,
      { httpAdapter: undefined } as unknown as HttpAdapterHost,
    );
    await recovery.sweep();
    expect(screening.recover.mock.calls).toEqual([[org1], [org2]]);
    expect(assessments.recover.mock.calls).toEqual([[org2]]);
  });

  it('assesses calls whose assessment a restart interrupted', async () => {
    const db = {
      query: jest.fn(async () => [{ id: 'attempt-1' }, { id: 'attempt-2' }]),
    } as unknown as DbService;
    const service = new CallAssessmentService(
      db,
      {} as OrganizationAiService,
      {} as HiringAutomationService,
    );
    const queue = jest
      .spyOn(service, 'queue')
      .mockImplementation(() => undefined);
    await service.recover('org-1');
    const [sql] = (db.query as jest.Mock).mock.calls[0] as [string];
    expect(sql).toContain("assessment_status='PENDING'");
    expect(sql).toContain('assessment_status IS NULL');
    expect(queue.mock.calls).toEqual([
      ['org-1', 'attempt-1'],
      ['org-1', 'attempt-2'],
    ]);
  });
});
