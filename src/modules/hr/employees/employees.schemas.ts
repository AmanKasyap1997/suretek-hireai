import { z } from 'zod';
import { paginationSchema } from '../../../platform/http/validation';

export const employeeListSchema = paginationSchema;
export type EmployeeListInput = z.infer<typeof employeeListSchema>;
