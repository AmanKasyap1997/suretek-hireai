import { z } from 'zod';
import { EmploymentType, AssignmentRole } from '../../../shared/enums';
import {
  listFields,
  listSchema,
  validDateRange,
} from '../../../shared/ta-list';
import { aiProviders } from '../../organization-integrations/ai-client';
import { callQuestionsSchema } from './call-questions';
import { interviewSetupSchema } from './interview-setup';
/** The jobs list: also the requests awaiting an HR Admin's approval. */
export const paginationSchema = listFields
  .extend({ awaiting: z.enum(['approval']).optional() })
  .refine(validDateRange, { message: 'Invalid date range' });
export { listSchema };

export const sendBackSchema = z
  .object({ note: z.string().trim().min(1).max(1000) })
  .strict();

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
    /** Screen new applications with the organization's AI provider. */
    autoScreen: z.boolean().optional(),
    /** What the AI asks on a candidate call, when AI calling is on. */
    callQuestions: callQuestionsSchema.optional(),
    /** How the AI books interviews (null: a recruiter books them). */
    interviewSetup: interviewSetupSchema.nullable().optional(),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().min(10).max(30_000),
    department: z.string().trim().min(1).max(150),
    location: z.string().trim().min(1).max(200),
  })
  .strict();

/** A job's interview booking, changeable until the job closes. */
export const interviewSetupUpdateSchema = z
  .object({ interviewSetup: interviewSetupSchema.nullable() })
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

const salary = z.number().nonnegative().max(999999999999.99).nullable();
export const jobDescriptionSchema = z
  .object({
    provider: z.enum(aiProviders).optional(),
    title: z.string().trim().min(2).max(200),
    department: z.string().trim().min(1).max(150),
    location: z.string().trim().min(1).max(200),
    employmentType: z.enum(EmploymentType).optional(),
    openings: z.number().int().min(1).max(100000).optional(),
    salaryMin: salary.optional(),
    salaryMax: salary.optional(),
    skills: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    guidance: z.string().trim().max(2000).optional(),
    currentDescription: z.string().trim().max(30_000).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.salaryMin == null ||
      input.salaryMax == null ||
      input.salaryMin <= input.salaryMax,
    { message: 'The salary minimum cannot exceed the maximum.' },
  );

export type JobDescriptionInput = z.infer<typeof jobDescriptionSchema>;
