import { z } from 'zod';
import { paginationSchema } from '../../../platform/http/validation';
export { paginationSchema };

export const jobSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().min(10).max(30_000),
    department: z.string().trim().min(1).max(150),
    location: z.string().trim().min(1).max(200),
  })
  .strict();

export const updateJobSchema = jobSchema
  .partial()
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Provide at least one job field.',
  });

export type JobInput = z.infer<typeof jobSchema>;

export type JobUpdate = z.infer<typeof updateJobSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
