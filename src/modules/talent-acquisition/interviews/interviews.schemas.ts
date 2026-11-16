import { z } from 'zod';
import { InterviewMode, InterviewStatus } from '../../../shared/enums';
import { paginationSchema } from '../../../platform/http/validation';

const timestamp = z.iso.datetime({ offset: true });
const panelists = z
  .array(z.string().uuid())
  .min(1)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Panelist IDs must be unique.',
  });
const meetingUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => value.startsWith('https://'), {
    message: 'Meeting links must use HTTPS.',
  })
  .nullable();
const location = z.string().trim().min(1).max(1000).nullable();

export const createInterviewSchema = z
  .object({
    applicationId: z.string().uuid(),
    round: z.string().trim().min(1).max(100),
    mode: z.enum(InterviewMode),
    startsAt: timestamp,
    endsAt: timestamp,
    location: location.optional(),
    meetingUrl: meetingUrl.optional(),
    panelistIds: panelists,
  })
  .strict();

export const rescheduleInterviewSchema = z
  .object({
    mode: z.enum(InterviewMode).optional(),
    startsAt: timestamp.optional(),
    endsAt: timestamp.optional(),
    location: location.optional(),
    meetingUrl: meetingUrl.optional(),
    panelistIds: panelists.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Provide at least one interview field.',
  })
  .refine(
    (input) => (input.startsAt === undefined) === (input.endsAt === undefined),
    { message: 'Provide startsAt and endsAt together.' },
  );

export const cancelInterviewSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

export const interviewListSchema = paginationSchema.extend({
  applicationId: z.string().uuid().optional(),
  status: z.enum(InterviewStatus).optional(),
});

export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;
export type RescheduleInterviewInput = z.infer<
  typeof rescheduleInterviewSchema
>;
export type InterviewListInput = z.infer<typeof interviewListSchema>;
