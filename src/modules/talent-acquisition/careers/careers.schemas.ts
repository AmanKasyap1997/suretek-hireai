import { z } from 'zod';
export const tenantSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
const MAX_PUBLIC_BYTES = 512 * 1024;
export const intakeSchema = z
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
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    website: z.string().max(500).default(''),
    captchaToken: z.string().max(4096).optional(),
    noticeVersion: z.string().trim().min(1).max(100),
    consents: z
      .object({
        CALL: z.boolean().default(false),
        RECORDING: z.boolean().default(false),
        TRANSCRIPTION: z.boolean().default(false),
      })
      .strict()
      .default({ CALL: false, RECORDING: false, TRANSCRIPTION: false }),
    resume: z
      .object({
        filename: z.string().min(1).max(255),
        base64: z
          .string()
          .max(Math.ceil(MAX_PUBLIC_BYTES / 3) * 4)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          )
          .refine(
            (value) => Buffer.byteLength(value, 'base64') <= MAX_PUBLIC_BYTES,
            { message: 'Public resume exceeds 512 KiB' },
          ),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IntakeInput = z.infer<typeof intakeSchema>;
