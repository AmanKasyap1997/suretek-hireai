import { z } from 'zod';
import { RejectionReason, ApplicationStage } from '../../../shared/enums';
import { listSchema as paginationSchema } from '../../../shared/ta-list';
export { paginationSchema };

export const applicationSchema = z
  .object({
    jobId: z.string().uuid(),
    candidateId: z.string().uuid(),
  })
  .strict();

export const stageSchema = z
  .object({
    reasonCode: z.enum(RejectionReason).optional(),
    note: z.string().trim().max(2000).optional(),
    stage: z
      .enum(ApplicationStage)
      .extract([
        ApplicationStage.SHORTLISTED,
        ApplicationStage.INTERVIEW,
        ApplicationStage.REJECTED,
      ]),
  })
  .strict()
  .refine((v) => v.stage !== ApplicationStage.REJECTED || !!v.reasonCode, {
    message: 'REJECTED requires reasonCode',
    path: ['reasonCode'],
  });

export type ApplicationInput = z.infer<typeof applicationSchema>;

export type StageInput = z.infer<typeof stageSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
