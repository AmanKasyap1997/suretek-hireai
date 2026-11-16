import { z } from 'zod';
import { paginationSchema } from '../platform/http/validation';
import { ApplicationStage, JobStatus } from './enums';
export const listSchema = paginationSchema
  .extend({
    jobId: z.string().uuid().optional(),
    stage: z.enum(ApplicationStage).optional(),
    status: z.enum(JobStatus).optional(),
    createdFrom: z.string().datetime({ offset: true }).optional(),
    createdTo: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    sort: z.enum(['created_at', 'updated_at']).default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine(
    (v) =>
      !v.createdFrom ||
      !v.createdTo ||
      new Date(v.createdFrom).getTime() <= new Date(v.createdTo).getTime(),
    { message: 'Invalid date range' },
  );
export type ListInput = z.infer<typeof listSchema>;
