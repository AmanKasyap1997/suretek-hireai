import { z } from 'zod';
export const providerIds = [
  'linkedin',
  'linkedin_profile',
  'linkedin_jobs',
  'openai',
  'anthropic',
  'google_ai',
  'google_calendar',
  'microsoft_calendar',
  'telephony',
  'plivo',
  'email',
  'careers_cms',
  'e_signature',
  'hris',
] as const;
export const methods = [
  'api_key',
  'bearer',
  'basic',
  'oauth2',
  'oauth_client_credentials',
  'oauth_refresh_token',
  'smtp',
  'account_token',
] as const;
export type Provider = (typeof providerIds)[number];
export type Method = (typeof methods)[number];
export const catalog: {
  provider: Provider;
  label: string;
  methods: Method[];
}[] = [
  {
    provider: 'linkedin',
    label: 'LinkedIn company pages',
    methods: ['oauth2'],
  },
  {
    provider: 'linkedin_profile',
    label: 'LinkedIn profile',
    methods: ['oauth2'],
  },
  {
    provider: 'linkedin_jobs',
    label: 'LinkedIn Jobs',
    methods: ['oauth_client_credentials'],
  },
  { provider: 'openai', label: 'OpenAI', methods: ['api_key'] },
  { provider: 'anthropic', label: 'Anthropic', methods: ['api_key'] },
  {
    provider: 'google_ai',
    label: 'Google AI Studio (Gemini)',
    methods: ['api_key'],
  },
  {
    provider: 'google_calendar',
    label: 'Google Calendar',
    methods: ['oauth2', 'oauth_refresh_token', 'bearer'],
  },
  {
    provider: 'microsoft_calendar',
    label: 'Microsoft Calendar',
    methods: ['oauth2', 'oauth_refresh_token', 'bearer'],
  },
  {
    provider: 'telephony',
    label: 'Telephony',
    methods: ['api_key', 'bearer', 'basic', 'oauth_client_credentials'],
  },
  {
    provider: 'plivo',
    label: 'Plivo',
    methods: ['account_token'],
  },
  { provider: 'email', label: 'Email', methods: ['smtp', 'api_key', 'bearer'] },
  {
    provider: 'careers_cms',
    label: 'Careers CMS / API',
    methods: ['api_key', 'bearer', 'basic', 'oauth_client_credentials'],
  },
  {
    provider: 'e_signature',
    label: 'E-signature',
    methods: ['api_key', 'bearer', 'oauth_client_credentials'],
  },
  {
    provider: 'hris',
    label: 'HRIS',
    methods: ['api_key', 'bearer', 'basic', 'oauth_client_credentials'],
  },
];
export const credentialFields: Record<Method, string[]> = {
  api_key: ['apiKey'],
  bearer: ['accessToken'],
  basic: ['username', 'password'],
  oauth2: ['clientId', 'clientSecret'],
  oauth_client_credentials: ['clientId', 'clientSecret', 'scope'],
  oauth_refresh_token: ['clientId', 'clientSecret', 'refreshToken'],
  smtp: ['username', 'password'],
  account_token: ['authId', 'authToken', 'phoneNumber'],
};
export const providerToggle = z.object({ enabled: z.boolean() }).strict();
const value = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => !/[\r\n\0]/.test(v), 'Control characters are not allowed');
export const connectionSchema = z
  .object({
    provider: z.enum(providerIds),
    environment: z.enum(['sandbox', 'production']),
    method: z.enum(methods),
    credentials: z.record(z.string(), value),
  })
  .strict()
  .superRefine((input, ctx) => {
    const allowed = catalog.find((p) => p.provider === input.provider)!;
    if (!allowed.methods.includes(input.method))
      ctx.addIssue({
        code: 'custom',
        path: ['method'],
        message: 'Unsupported method for this provider',
      });
    const fields = credentialFields[input.method];
    if (
      input.credentials.phoneNumber &&
      !/^\+[1-9][0-9]{7,14}$/.test(input.credentials.phoneNumber)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['credentials', 'phoneNumber'],
        message: 'Use the international format, e.g. +919876543210',
      });
    for (const field of fields.filter(
      (f) => !['username', 'clientId', 'scope', 'phoneNumber'].includes(f),
    )) {
      if (input.credentials[field] && input.credentials[field].length < 8)
        ctx.addIssue({
          code: 'custom',
          path: ['credentials', field],
          message: 'Use at least 8 characters',
        });
    }
    for (const field of fields.filter((f) => f !== 'scope'))
      if (!input.credentials[field])
        ctx.addIssue({
          code: 'custom',
          path: ['credentials', field],
          message: 'Required',
        });
    for (const field of Object.keys(input.credentials))
      if (!fields.includes(field))
        ctx.addIssue({
          code: 'custom',
          path: ['credentials', field],
          message: 'Unknown credential field',
        });
  });
export const oauthCompleteSchema = z
  .object({
    state: z.string().regex(/^[a-f0-9]{64}$/),
    code: z.string().min(1).max(4096),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionSchema>;

export const oauthStartSchema = z.union([
  connectionSchema,
  z
    .object({
      provider: z.enum([
        'linkedin',
        'linkedin_profile',
        'google_calendar',
        'microsoft_calendar',
      ]),
      environment: z.enum(['sandbox', 'production']),
      method: z.literal('oauth2'),
      credentials: z.object({}).strict().default({}),
    })
    .strict(),
]);
