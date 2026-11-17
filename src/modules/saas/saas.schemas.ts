import { organizationFields } from '../super-admin/super-admin.schemas';
import { z } from 'zod';
import { ORGANIZATION_STAFF_ROLES } from '../../shared/role-groups';
export { ORGANIZATION_STAFF_ROLES } from '../../shared/role-groups';
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      Array.from(value).every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    'Control characters are not allowed',
  );
export const organizationSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
export const createOrganizationSchema = z
  .object({
    ...organizationFields,
    name,
    slug: organizationSlug,
    adminName: name,
    adminEmail: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((v) => v.toLowerCase()),
  })
  .strict();
export const inviteStaffSchema = z
  .object({
    fullName: name,
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((v) => v.toLowerCase()),
    role: z.enum(ORGANIZATION_STAFF_ROLES),
  })
  .strict();
export const acceptInvitationSchema = z
  .object({
    organizationSlug,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(128),
  })
  .strict();
export const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type ListInput = z.infer<typeof listSchema>;

export const staffRolesSchema = z
  .object({ roles: z.array(z.enum(ORGANIZATION_STAFF_ROLES)).min(1).max(8) })
  .strict();
