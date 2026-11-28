import { z } from 'zod';
export const modules = [
  'hiring',
  'core_hr',
  'leave',
  'attendance',
  'onboarding',
  'payroll',
  'compensation',
  'expenses',
  'offboarding',
  'performance',
  'learning',
  'engagement',
  'helpdesk',
] as const;
export const defaults: (typeof modules)[number][] = [
  'hiring',
  'core_hr',
  'leave',
  'attendance',
  'onboarding',
];
export const organizationFields = {
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)
    .max(253)
    .nullable()
    .default(null),
  country: z.string().trim().max(100).default(''),
  timezone: z
    .string()
    .max(100)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid timezone')
    .default('UTC'),
  status: z.enum(['trial', 'active']).default('active'),
  plan: z.string().trim().min(1).max(80).default('standard'),
  enabled_modules: z
    .array(z.enum(modules))
    .max(modules.length)
    .default(defaults),
  limits: z
    .object({
      max_users: z.number().int().min(1).max(1000000),
      call_minutes_per_month: z.number().int().min(0).max(100000000),
      storage_mb: z.number().int().min(0).max(100000000),
    })
    .strict()
    .default({
      max_users: 100,
      call_minutes_per_month: 1000,
      storage_mb: 10240,
    }),
  trial_ends_at: z.string().datetime().nullable().default(null),
};
export const editOrganization = z
  .object({ name: z.string().trim().min(1).max(200), ...organizationFields })
  .strict();
export const statusSchema = z
  .object({
    status: z.enum(['suspended', 'active']),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== 'suspended' || !!v.reason,
    'A suspension reason is required',
  );
export const deleteSchema = z
  .object({ confirmation: z.string().max(200) })
  .strict();
export const filters = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  search: z.string().max(200).default(''),
  status: z.enum(['trial', 'active', 'suspended']).optional(),
  plan: z.string().max(80).optional(),
  sort: z.enum(['name', 'created_at']).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  action: z.string().max(100).optional(),
  organization_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export const integrationSchema = z
  .object({
    provider: z.enum([
      'openai',
      'google_calendar',
      'microsoft_calendar',
      'telephony',
      'email',
      'careers_cms',
      'e_signature',
      'hris',
    ]),
    environment: z.enum(['sandbox', 'production']),
    organization_id: z.string().uuid().nullable().default(null),
    credential: z.string().min(8).max(8192),
  })
  .strict();
export const settingsSchema = z
  .object({
    retention_days: z.number().int().min(1).max(3650),
    calling_start: z.number().int().min(0).max(23),
    calling_end: z.number().int().min(1).max(24),
    call_quota: z.number().int().min(0).max(1000000),
    emergency_pause: z.boolean(),
    password_min_length: z.number().int().min(12).max(128),
    session_seconds: z.number().int().min(300).max(86400),
  })
  .strict()
  .refine(
    (v) => v.calling_end > v.calling_start,
    'Calling end must follow start',
  );
export const adminSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email: z
      .email()
      .max(320)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const adminStatusSchema = z.object({ active: z.boolean() }).strict();
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().max(128),
    password: z.string().min(12).max(128),
  })
  .strict()
  .refine(
    (v) => v.password !== v.currentPassword,
    'Your new password must be different from your current password.',
  );
export type Filters = z.infer<typeof filters>;
