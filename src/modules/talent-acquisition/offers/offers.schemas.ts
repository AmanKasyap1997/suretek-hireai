import { z } from 'zod';
import { paginationSchema } from '../../../platform/http/validation';
export { paginationSchema };

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

export type OfferInput = z.infer<typeof offerSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
