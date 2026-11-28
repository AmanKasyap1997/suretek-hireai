import { z } from 'zod';
import { readConfig } from '../../platform/config';
import { POST_TEXT_LIMIT } from './linkedin-client';
export const companyUrn = z
  .string()
  .regex(/^urn:li:organization:[1-9][0-9]{0,19}$/);
/**
 * HireAI's own apply page on a developer's machine, for test posts. Never in
 * production: candidates can't open a localhost link.
 */
const localApplyPage = (u: URL) =>
  readConfig().NODE_ENV !== 'production' &&
  u.protocol === 'http:' &&
  (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
export const applicationUrl = z
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return (
      (u.protocol === 'https:' || localApplyPage(u)) &&
      !u.username &&
      !u.password
    );
  }, 'Use a public HTTPS application URL');
/** Who can see a post on a member's profile. */
export const profileVisibility = z.enum(['PUBLIC', 'CONNECTIONS']);
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
    channel: z.enum(['company_announcement', 'profile_post', 'job_listing']),
    applicationUrl,
    pageUrn: companyUrn.optional(),
    pageStart: z.number().int().min(0).max(10000).default(0),
    commentary: z.string().trim().max(POST_TEXT_LIMIT).optional(),
    visibility: profileVisibility.optional(),
  })
  .strict();
export const linkedinPublishSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();
export const linkedinPageQuery = z
  .object({ start: z.coerce.number().int().min(0).max(10000).default(0) })
  .strict();
