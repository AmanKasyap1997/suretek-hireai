import { z } from 'zod';
import { paginationSchema } from '../platform/http/validation';
import { ApplicationStage, JobStatus } from './enums';
/** The shared list filters, before the date-range check. */
export const listFields = paginationSchema.extend({
  jobId: z.string().uuid().optional(),
  stage: z.enum(ApplicationStage).optional(),
  status: z.enum(JobStatus).optional(),
  createdFrom: z.string().datetime({ offset: true }).optional(),
  createdTo: z.string().datetime({ offset: true }).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['created_at', 'updated_at']).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});
export const validDateRange = (v: {
  createdFrom?: string;
  createdTo?: string;
}) =>
  !v.createdFrom ||
  !v.createdTo ||
  new Date(v.createdFrom).getTime() <= new Date(v.createdTo).getTime();
export const listSchema = listFields.refine(validDateRange, {
  message: 'Invalid date range',
});
export type ListInput = z.infer<typeof listSchema>;
