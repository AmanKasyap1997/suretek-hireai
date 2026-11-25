import { z } from 'zod';
import { RejectionReason, ApplicationStage } from '../../../shared/enums';
import { listFields, validDateRange } from '../../../shared/ta-list';

export const screeningFilters = [
  'screened',
  'not_screened',
  'in_progress',
  'failed',
] as const;

/** The shared list filters, plus AI screening sort and filter. */
export const paginationSchema = listFields
  .extend({
    sort: z.enum(['created_at', 'updated_at', 'score']).default('created_at'),
    screening: z.enum(screeningFilters).optional(),
  })
  .refine(validDateRange, { message: 'Invalid date range' });

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
