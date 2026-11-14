import { z } from 'zod';

export const consentSchema = z
  .object({
    scope: z.enum(['CALL', 'RECORDING', 'TRANSCRIPTION']),
    granted: z.boolean(),
    source: z.string().trim().min(3).max(1000),
  })
  .strict();

export const callRequestSchema = z
  .object({
    applicationId: z.string().uuid(),
    language: z.enum(['EN', 'HI']),
    recording: z.boolean().default(false),
    transcription: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(8).max(100),
  })
  .strict();

export const callingPaginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export type ConsentInput = z.infer<typeof consentSchema>;
export type CallRequestInput = z.infer<typeof callRequestSchema>;
export type CallingPagination = z.infer<typeof callingPaginationSchema>;
