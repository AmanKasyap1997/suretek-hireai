import { z } from 'zod';
export const companyUrn = z
  .string()
  .regex(/^urn:li:organization:[1-9][0-9]{0,19}$/);
export const linkedinSetupSchema = z
  .object({
    environment: z.enum(['sandbox', 'production']),
    companyUrn,
    clientId: z.string().min(1).max(1024),
    clientSecret: z.string().min(8).max(8192),
  })
  .strict();
export const linkedinPreviewSchema = z
  .object({
    jobId: z.uuid(),
    channel: z.enum(['company_announcement', 'job_listing']),
    applicationUrl: z
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.password;
      }, 'Use a public HTTPS application URL'),
    pageUrn: companyUrn.optional(),
    pageStart: z.number().int().min(0).max(10000).default(0),
    commentary: z.string().trim().max(2000).optional(),
  })
  .strict();
export const linkedinPublishSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
export const linkedinPageQuery = z
  .object({ start: z.coerce.number().int().min(0).max(10000).default(0) })
  .strict();
