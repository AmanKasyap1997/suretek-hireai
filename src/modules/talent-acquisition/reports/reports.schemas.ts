import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const timestamp = z.string().datetime({ offset: true });

export const recruitmentReportQuerySchema = z
  .object({
    jobId: z.string().uuid().optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict()
  .transform((input, context) => {
    const now = Date.now();
    const end = input.to ? Date.parse(input.to) : now;
    const start = input.from ? Date.parse(input.from) : end - 30 * DAY_MS;
    if (start >= end || end - start > 366 * DAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'Report period must be positive and at most 366 days',
      });
      return z.NEVER;
    }
    return {
      jobId: input.jobId,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      asOf: new Date(now).toISOString(),
      observedTo: new Date(Math.min(end, now)).toISOString(),
    };
  });

export type RecruitmentReportQuery = z.infer<
  typeof recruitmentReportQuerySchema
>;
