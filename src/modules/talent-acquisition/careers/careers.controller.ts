import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../../shared/roles.decorator';
import {
  BodySchema,
  parse,
  paginationSchema,
} from '../../../platform/http/validation';
import { CareersService } from './careers.service';
import { intakeSchema, tenantSlugSchema } from './careers.schemas';
@ApiTags('Public careers')
@Public()
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('public/:tenantSlug/jobs')
export class CareersController {
  constructor(private readonly careers: CareersService) {}
  @Get()
  list(@Param('tenantSlug') slug: string, @Query() query: unknown) {
    return this.careers.list(
      parse(tenantSlugSchema, slug),
      parse(paginationSchema, query),
    );
  }
  @Get(':id')
  get(
    @Param('tenantSlug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.careers.get(parse(tenantSlugSchema, slug), id);
  }
  @Post(':id/applications')
  @HttpCode(202)
  @BodySchema(intakeSchema)
  apply(
    @Param('tenantSlug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.careers.apply(
      parse(tenantSlugSchema, slug),
      id,
      parse(intakeSchema, body),
      req.ip ?? req.socket.remoteAddress ?? '0.0.0.0',
      req.headers['user-agent'] ?? '',
    );
  }
}
