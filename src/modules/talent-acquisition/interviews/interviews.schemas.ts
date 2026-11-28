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
const calendarProvider = z.enum(['google_calendar', 'microsoft_calendar']);

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
    /**
     * Add it to the organization's connected calendar, which invites the
     * panel and the candidate (and creates a Meet or Teams link for a video
     * interview without one).
     */
    sendInvitations: z.boolean().default(false),
    /** Which connected calendar; else the organization's choice. */
    calendarProvider: calendarProvider.optional(),
  })
  .strict();

export const rescheduleInterviewSchema = z
  .object({
    round: z.string().trim().min(1).max(100).optional(),
    mode: z.enum(InterviewMode).optional(),
    startsAt: timestamp.optional(),
    endsAt: timestamp.optional(),
    location: location.optional(),
    meetingUrl: meetingUrl.optional(),
    panelistIds: panelists.optional(),
    /** Add it to the connected calendar too, if it isn't there yet. */
    sendInvitations: z.boolean().optional(),
    /** Add it to (or move it to) this connected calendar. */
    calendarProvider: calendarProvider.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Provide at least one interview field.',
  })
  .refine(
    (input) => (input.startsAt === undefined) === (input.endsAt === undefined),
    { message: 'Provide startsAt and endsAt together.' },
  );

export const addToCalendarSchema = z
  .object({ calendarProvider: calendarProvider.optional() })
  .strict();

export const interviewCalendarSchema = z
  .object({ provider: calendarProvider })
  .strict();

export const cancelInterviewSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

export const interviewListSchema = paginationSchema.extend({
  applicationId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  status: z.enum(InterviewStatus).optional(),
  /** Scheduled and not over yet (soonest first), or over (latest first). */
  when: z.enum(['upcoming', 'past']).optional(),
  /** Interviews overlapping this time range, e.g. a month in the calendar. */
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;
export type RescheduleInterviewInput = z.infer<
  typeof rescheduleInterviewSchema
>;
export type InterviewListInput = z.infer<typeof interviewListSchema>;
