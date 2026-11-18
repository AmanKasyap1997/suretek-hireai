import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser, Role } from '../../shared/actor';
import { Roles } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import { LinkedInService } from './linkedin.service';
import {
  linkedinPageQuery,
  linkedinPreviewSchema,
  linkedinPublishSchema,
  linkedinSetupSchema,
} from './linkedin.schemas';
@Controller('super-admin/integration-providers/linkedin-jobs')
@Roles(Role.SUPER_ADMIN)
export class LinkedInSetupController {
  constructor(private readonly service: LinkedInService) {}
  @Post('organizations/:id')
  @BodySchema(linkedinSetupSchema)
  setup(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.setupJobs(actor, id, parse(linkedinSetupSchema, body));
  }
}
@Controller('organization/integrations/linkedin')
@Roles(Role.HR_ADMIN)
export class LinkedInController {
  constructor(private readonly service: LinkedInService) {}
  @Get('jobs') jobs(@CurrentUser() actor: Actor) {
    return this.service.jobs(actor);
  }
  @Get('pages')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  pages(@CurrentUser() actor: Actor, @Query() q: unknown) {
    return this.service.pages(actor, parse(linkedinPageQuery, q).start);
  }
  @Get('publications') history(@CurrentUser() actor: Actor) {
    return this.service.history(actor);
  }
  @Post('preview')
  @BodySchema(linkedinPreviewSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  preview(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.service.preview(actor, parse(linkedinPreviewSchema, body));
  }
  @Post('publications/:id/publish')
  @BodySchema(linkedinPublishSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  publish(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    parse(linkedinPublishSchema, body);
    return this.service.publish(actor, id);
  }
  @Post('publications/:id/refresh')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  refresh(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refresh(actor, id);
  }
}
