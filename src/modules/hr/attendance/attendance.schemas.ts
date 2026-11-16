import { z } from 'zod';
import { paginationSchema } from '../../../platform/http/validation';
import { dateSchema } from '../hr.schemas';

export const attendanceSchema = z
  .object({
    employeeId: z.string().uuid(),
    workDate: dateSchema,
    checkIn: z.string().datetime({ offset: true }),
    checkOut: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (v) => !v.checkOut || Date.parse(v.checkOut) > Date.parse(v.checkIn),
    'Check out must follow check in',
  );

export const attendanceListSchema = paginationSchema;
export type AttendanceInput = z.infer<typeof attendanceSchema>;
export type AttendanceListInput = z.infer<typeof attendanceListSchema>;
