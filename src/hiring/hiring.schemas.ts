import { z } from 'zod';
import { ApplicationStage } from '../common/enums';
import { paginationSchema } from '../common/validation';
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
export const candidateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, 'Use an E.164 phone number.')
      .nullable()
      .optional(),
  })
  .strict();
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
export const offerSchema = z
  .object({
    applicationId: z.string().uuid(),
    annualCtc: z
      .string()
      .regex(
        /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/,
        'Use a positive decimal amount with at most two decimal places.',
      )
      .refine((value) => Number(value) > 0, {
        message: 'CTC must be positive.',
      }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('INR'),
    joiningDate: z.string().date(),
  })
  .strict();
export const acceptOfferSchema = z
  .object({
    acceptanceReference: z.string().trim().min(5).max(500),
  })
  .strict();

export type Pagination = z.infer<typeof paginationSchema>;
export type JobInput = z.infer<typeof jobSchema>;
export type JobUpdate = z.infer<typeof updateJobSchema>;
export type CandidateInput = z.infer<typeof candidateSchema>;
export type ApplicationInput = z.infer<typeof applicationSchema>;
export type StageInput = z.infer<typeof stageSchema>;
export type OfferInput = z.infer<typeof offerSchema>;
