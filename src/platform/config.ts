import { z } from 'zod';

const postgresUrlSchema = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:/.test(value));

const schema = z
  .object({
    INTAKE_NOTICE_VERSION: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .default('2026-11-v1'),
    INTAKE_IP_LIMIT: z.coerce.number().int().min(1).max(10000).default(20),
    INTAKE_EMAIL_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
    INTAKE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86400)
      .default(3600),
    CANDIDATE_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(36500)
      .default(365),
    RESUME_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    RESUME_STORAGE: z.enum(['local', 's3']).default('local'),
    RESUME_STORAGE_ROOT: z.string().min(1).default('var/private/resumes'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .optional(),
    S3_REGION: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_SESSION_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    OFFER_MAKER_CHECKER: z.enum(['true', 'false']).optional(),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DATABASE_URL: postgresUrlSchema,
    // Migration scripts enforce this in production. The API never needs owner credentials.
    DATABASE_MIGRATION_URL: postgresUrlSchema.optional(),
    JWT_SECRET: z
      .string()
      .min(32)
      .refine(
        (v) => !/change|replace|placeholder/i.test(v),
        'Generate a random JWT_SECRET',
      ),
    JWT_EXPIRES_IN_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86400)
      .default(900),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    PGSSLMODE: z.enum(['disable', 'require']).default('disable'),
    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    TRUST_PROXY: z
      .string()
      .regex(
        /^(?:false|0|[1-9]\d*)$/,
        'Use false or an integer number of proxy hops',
      )
      .default('false')
      .transform((value) => (value === 'false' ? false : Number(value)))
      .refine(
        (value) => value === false || Number.isSafeInteger(value),
        'Proxy hops must be a nonnegative safe integer',
      ),
  })
  .transform((config) => ({
    ...config,
    OFFER_MAKER_CHECKER:
      config.OFFER_MAKER_CHECKER === undefined
        ? config.NODE_ENV === 'production'
        : config.OFFER_MAKER_CHECKER === 'true',
    SWAGGER_ENABLED: config.SWAGGER_ENABLED ?? config.NODE_ENV !== 'production',
  }));
export type AppConfig = z.infer<typeof schema>;
export function readConfig(): AppConfig {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const cfg = result.data;
  if (cfg.RESUME_STORAGE === 's3') {
    if (
      !cfg.S3_ENDPOINT ||
      !cfg.S3_BUCKET ||
      !cfg.S3_ACCESS_KEY_ID ||
      !cfg.S3_SECRET_ACCESS_KEY
    )
      throw new Error('S3 storage requires endpoint, bucket and credentials');
    const endpoint = new URL(cfg.S3_ENDPOINT);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      throw new Error('S3_ENDPOINT must be an HTTP(S) origin');
    if (cfg.NODE_ENV === 'production' && endpoint.protocol !== 'https:')
      throw new Error('Production S3_ENDPOINT must use HTTPS');
  }

  for (const origin of cfg.CORS_ORIGINS.split(',').filter(Boolean)) {
    if (new URL(origin).origin !== origin || origin === '*')
      throw new Error('CORS_ORIGINS must contain exact origins');
  }
  return cfg;
}
