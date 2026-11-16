import { BadRequestException } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException({
      message: 'Validation failed',
      errors: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  return result.data;
}
export function BodySchema(schema: z.ZodTypeAny): MethodDecorator {
  return ApiBody({
    schema: z.toJSONSchema(schema, {
      target: 'openapi-3.0',
      io: 'input',
      unrepresentable: 'any',
    }) as any,
  });
}
export const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
