import { z } from 'zod';

const postgresUrlSchema = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:/.test(value));

const schema = z
  .object({
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
  for (const origin of cfg.CORS_ORIGINS.split(',').filter(Boolean)) {
    if (new URL(origin).origin !== origin || origin === '*')
      throw new Error('CORS_ORIGINS must contain exact origins');
  }
  return cfg;
}
