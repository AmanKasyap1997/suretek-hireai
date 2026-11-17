import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../../shared/roles.decorator';
import { BodySchema, parse } from '../../../platform/http/validation';
import { tenantSlugSchema } from './careers.schemas';
import { ContactVerificationService } from './contact-verification.service';
const schema = z
  .object({
    token: z
      .string()
      .regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/)
      .refine((v) => z.uuid().safeParse(v.split('.')[0]).success),
  })
  .strict();
@Public()
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('public/:tenantSlug/contact-verification')
export class ContactVerificationController {
  constructor(private readonly verification: ContactVerificationService) {}
  @Post()
  @HttpCode(202)
  @BodySchema(schema)
  verify(
    @Param('tenantSlug') slug: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.verification.verify(
      parse(tenantSlugSchema, slug),
      parse(schema, body).token,
      req.ip ?? '0.0.0.0',
      req.headers['user-agent'] ?? '',
    );
  }
}
