import { z } from 'zod';
export const tenantSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
const MAX_PUBLIC_BYTES = 512 * 1024;

export const noticePeriods = [
  'IMMEDIATE',
  'DAYS_15',
  'DAYS_30',
  'DAYS_45',
  'DAYS_60',
  'DAYS_90',
  'OVER_90_DAYS',
  'SERVING_NOTICE',
] as const;
export const applicationSources = [
  'DIRECT',
  'CAREERS_SITE',
  'LINKEDIN',
  'REFERRAL',
  'JOB_PORTAL',
  'SOCIAL',
  'OTHER',
] as const;

// An empty answer is the same as no answer.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();
const webUrl = (hosts?: RegExp, message = 'Enter a full web address') =>
  z
    .string()
    .trim()
    .max(300)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          (!hosts || hosts.test(url.hostname))
        );
      } catch {
        return false;
      }
    }, message)
    .transform((value) => value || undefined)
    .optional();
const money = z.number().finite().min(0).max(999_999_999_999.99);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'Enter a valid date',
  });

/** Everything on the apply form except the resume file. */
const fields = {
  fullName: z.string().trim().min(2).max(200),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  phone: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      'Enter the phone number with its country code, for example +919876543210',
    ),
  currentLocation: z.string().trim().min(2).max(120),
  willingToRelocate: z.boolean().optional(),
  totalExperienceMonths: z.number().int().min(0).max(720),
  currentCompany: optionalText(200),
  currentTitle: optionalText(200),
  noticePeriod: z.enum(noticePeriods),
  lastWorkingDay: isoDate.optional(),
  currentCtc: money.optional(),
  expectedCtc: money.refine((value) => value > 0, 'Enter your expected pay'),
  ctcCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('INR'),
  linkedinUrl: webUrl(
    /(^|\.)linkedin\.com$/i,
    'Enter your LinkedIn profile address, for example https://www.linkedin.com/in/your-name',
  ),
  portfolioUrl: webUrl(
    undefined,
    'Enter a full web address, starting with https://',
  ),
  coverLetter: optionalText(4000),
  source: z.enum(applicationSources).default('DIRECT'),
  referrer: optionalText(200),
  website: z.string().max(500).default(''),
  captchaToken: z.string().max(4096).optional(),
  noticeVersion: z.string().trim().min(1).max(100),
  privacyAccepted: z.literal(true, {
    error: 'Agree to the privacy notice to apply',
  }),
  /**
   * Separate contact choices (API clients). Omitted: the candidate accepted
   * the apply form's notice that they may be called about the application,
   * and that calls may be recorded and transcribed.
   */
  consents: z
    .object({
      CALL: z.boolean().default(false),
      RECORDING: z.boolean().default(false),
      TRANSCRIPTION: z.boolean().default(false),
    })
    .strict()
    .optional(),
};
type Fields = {
  noticePeriod: (typeof noticePeriods)[number];
  lastWorkingDay?: string;
  source: (typeof applicationSources)[number];
  referrer?: string;
};
function consistent(value: Fields, context: z.RefinementCtx) {
  if (value.lastWorkingDay && value.noticePeriod !== 'SERVING_NOTICE')
    context.addIssue({
      code: 'custom',
      path: ['lastWorkingDay'],
      message: 'A last working day only applies while serving notice',
    });
  if (value.referrer && value.source !== 'REFERRAL')
    context.addIssue({
      code: 'custom',
      path: ['referrer'],
      message: 'A referrer only applies to referrals',
    });
}

/** The multipart `application` field; the resume arrives as a file part. */
export const applicationFieldsSchema = z
  .object(fields)
  .strict()
  .superRefine(consistent);

/** JSON intake: the resume travels inline as base64, up to 512 KiB. */
export const intakeSchema = z
  .object({
    ...fields,
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
            {
              message:
                'Public resume exceeds 512 KiB; send larger files as multipart/form-data',
            },
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine(consistent);
export type ApplicationFields = z.infer<typeof applicationFieldsSchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
