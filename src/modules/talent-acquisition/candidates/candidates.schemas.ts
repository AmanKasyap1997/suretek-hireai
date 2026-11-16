import { z } from 'zod';
import { listSchema as paginationSchema } from '../../../shared/ta-list';
export { paginationSchema };

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

export type CandidateInput = z.infer<typeof candidateSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
