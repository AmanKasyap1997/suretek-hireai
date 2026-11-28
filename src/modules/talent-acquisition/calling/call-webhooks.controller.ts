import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../../shared/roles.decorator';
import { callTokenValid } from './call-links';
import { PhoneCallsService, PlivoWebhook } from './phone-calls.service';

/**
 * Plivo's callbacks for AI calls. Each address carries a per-call token, and
 * each request must also carry Plivo's signature for the organization's
 * account; anything else is refused.
 */
@ApiExcludeController()
@Public()
@Controller('public/calls/plivo')
export class CallWebhooksController {
  constructor(private readonly phone: PhoneCallsService) {}

  private webhook(
    tenantId: string,
    attemptId: string,
    token: unknown,
    request: Request,
    body: unknown,
  ): PlivoWebhook {
    if (!callTokenValid(tenantId, attemptId, token))
      throw new ForbiddenException();
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value.join(',') : value;
    };
    return {
      tenantId,
      attemptId,
      path: request.originalUrl,
      params:
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : {},
      nonce: header('x-plivo-signature-v3-nonce'),
      signatures: [
        header('x-plivo-signature-v3'),
        header('x-plivo-signature-ma-v3'),
      ],
    };
  }

  @Post(':tenantId/:attemptId/answer')
  @HttpCode(200)
  @Header('Content-Type', 'application/xml')
  @Header('Cache-Control', 'no-store')
  async answer(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Query('token') token: unknown,
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    const xml = await this.phone.answer(
      this.webhook(tenantId, attemptId, token, request, body),
    );
    if (!xml) throw new ForbiddenException();
    return xml;
  }

  @Post(':tenantId/:attemptId/hangup')
  @HttpCode(204)
  async hangup(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Query('token') token: unknown,
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    if (
      !(await this.phone.hangup(
        this.webhook(tenantId, attemptId, token, request, body),
      ))
    )
      throw new ForbiddenException();
  }
}
