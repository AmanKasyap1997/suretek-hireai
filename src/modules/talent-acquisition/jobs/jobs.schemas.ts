import { z } from 'zod';
import { EmploymentType, AssignmentRole } from '../../../shared/enums';
import { listSchema as paginationSchema } from '../../../shared/ta-list';
export { paginationSchema };

export const jobSchema = z
  .object({
    openings: z.number().int().min(1).max(100000).optional(),
    employmentType: z.enum(EmploymentType).optional(),
    salaryMin: z
      .number()
      .nonnegative()
      .max(999999999999.99)
      .nullable()
      .optional(),
    salaryMax: z
      .number()
      .nonnegative()
      .max(999999999999.99)
      .nullable()
      .optional(),
    hiringManagerUserId: z.string().uuid().nullable().optional(),
    screeningCriteria: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(500),
            weight: z.number().positive().max(100),
            must_have: z.boolean(),
          })
          .strict(),
      )
      .max(100)
      .refine((v) => new Set(v.map((x) => x.id)).size === v.length, {
        message: 'Duplicate criteria ids',
      })
      .optional(),
    closeReason: z.string().trim().min(1).max(1000).nullable().optional(),
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

export const assignmentSchema = z
  .object({ userId: z.string().uuid(), role: z.enum(AssignmentRole) })
  .strict();

export const closeJobSchema = z
  .object({ closeReason: z.string().trim().min(1).max(1000).optional() })
  .strict();
