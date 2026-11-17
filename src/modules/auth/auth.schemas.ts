import { z } from 'zod';
import { Role } from '../../shared/enums';

const email = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((v) => v.toLowerCase());
export const loginSchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    organizationSlug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
      .optional(),
    email,
    password: z.string().min(1).max(1024),
  })
  .strict()
  .refine(
    (value) => Boolean(value.tenantId) !== Boolean(value.organizationSlug),
    'Supply exactly one organizationSlug or legacy tenantId',
  );
export const createUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email,
    password: z.string().min(12).max(128),
    role: z.enum(Role),
  })
  .strict();
export const userStatusSchema = z.object({ active: z.boolean() }).strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UserStatusInput = z.infer<typeof userStatusSchema>;
