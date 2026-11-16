import { z } from 'zod';
import { paginationSchema } from '../../../platform/http/validation';
import { LeaveStatus, LeaveType } from '../../../shared/enums';
import { dateSchema } from '../hr.schemas';

export const leaveSchema = z
  .object({
    employeeId: z.string().uuid(),
    type: z.enum(LeaveType),
    startDate: dateSchema,
    endDate: dateSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, 'End date must follow start date');

export const reviewSchema = z
  .object({
    status: z
      .enum(LeaveStatus)
      .extract([LeaveStatus.APPROVED, LeaveStatus.REJECTED]),
  })
  .strict();

export const leaveListSchema = paginationSchema;
export type LeaveInput = z.infer<typeof leaveSchema>;
export type LeaveReviewInput = z.infer<typeof reviewSchema>;
export type LeaveListInput = z.infer<typeof leaveListSchema>;
