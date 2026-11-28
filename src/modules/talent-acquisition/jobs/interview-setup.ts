import { z } from 'zod';

/** How an interview is held. */
export const interviewModes = ['VIDEO', 'PHONE', 'ONSITE'] as const;

const unique = <T>(values: T[]) => new Set(values).size === values.length;

/**
 * How the AI books a job's interviews on its booking call: the round, its
 * length and type, the panel, and the days and hours (in the calling time
 * zone) to offer.
 */
export const interviewSetupSchema = z
  .object({
    round: z.string().trim().min(1).max(100),
    minutes: z.union([
      z.literal(30),
      z.literal(45),
      z.literal(60),
      z.literal(90),
    ]),
    mode: z.enum(interviewModes),
    /** Onsite: where. */
    location: z.string().trim().min(1).max(1000).nullable().optional(),
    panelistIds: z
      .array(z.string().uuid())
      .min(1)
      .max(10)
      .refine(unique, { message: 'Each panel member once.' }),
    /** Days to offer: 0 Sunday … 6 Saturday. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine(unique, { message: 'Each day once.' }),
    /** Interview hours, in minutes after midnight. */
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((v) => v.endMinute - v.startMinute >= v.minutes, {
    message: 'The interview hours must fit at least one interview.',
    path: ['endMinute'],
  })
  .refine((v) => v.mode !== 'ONSITE' || !!v.location, {
    message: 'Onsite interviews need a location.',
    path: ['location'],
  });

export type InterviewSetup = z.infer<typeof interviewSetupSchema>;

/** A saved setup, or null if there's none (or it's no longer valid). */
export function interviewSetup(value: unknown): InterviewSetup | null {
  const parsed = interviewSetupSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
