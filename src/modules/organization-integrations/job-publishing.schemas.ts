import { z } from 'zod';
import { POST_TEXT_LIMIT } from './linkedin-client';
import {
  applicationUrl,
  companyUrn,
  profileVisibility,
} from './linkedin.schemas';

/** External destinations, in the order they are sent. */
export const publishingChannels = [
  'careers_website',
  'company_announcement',
  'profile_post',
  'job_listing',
] as const;
export type PublishingChannel = (typeof publishingChannels)[number];
/** Channels whose posts HireAI can delete from LinkedIn. */
export const removableChannelSchema = z.enum([
  'company_announcement',
  'profile_post',
]);
export type RemovableChannel = z.infer<typeof removableChannelSchema>;

export const jobChannelsSchema = z
  .object({
    channels: z
      .array(z.enum(publishingChannels))
      .min(1)
      .max(publishingChannels.length)
      .refine((v) => new Set(v).size === v.length, 'Duplicate channels'),
    applicationUrl: applicationUrl.optional(),
    pageUrn: companyUrn.optional(),
    pageStart: z.number().int().min(0).max(10000).default(0),
    commentary: z.string().trim().max(POST_TEXT_LIMIT).optional(),
    visibility: profileVisibility.default('PUBLIC'),
    // Posting is public: the request must confirm the reviewed content.
    confirmed: z.literal(true),
  })
  .strict()
  .refine((v) => !v.channels.includes('company_announcement') || !!v.pageUrn, {
    message: 'Choose a LinkedIn company page.',
    path: ['pageUrn'],
  });
export type JobChannelsInput = z.infer<typeof jobChannelsSchema>;
