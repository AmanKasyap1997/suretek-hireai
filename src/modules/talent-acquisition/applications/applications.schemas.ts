import { z } from 'zod';
import { ApplicationStage } from '../../../shared/enums';
import { paginationSchema } from '../../../platform/http/validation';
export { paginationSchema };

export const applicationSchema = z
  .object({
    jobId: z.string().uuid(),
    candidateId: z.string().uuid(),
  })
  .strict();

export const stageSchema = z
  .object({
    stage: z
      .enum(ApplicationStage)
      .extract([
        ApplicationStage.SHORTLISTED,
        ApplicationStage.INTERVIEW,
        ApplicationStage.REJECTED,
      ]),
  })
  .strict();

export type ApplicationInput = z.infer<typeof applicationSchema>;

export type StageInput = z.infer<typeof stageSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
