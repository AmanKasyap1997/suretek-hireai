import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Actor, CurrentUser, Role } from '../../shared/actor';
import { Roles } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import {
  connectionSchema,
  oauthCompleteSchema,
  providerIds,
  providerToggle,
} from './catalog';
import { OrganizationIntegrationsService } from './organization-integrations.service';
@Controller('super-admin/integration-providers')
@Roles(Role.SUPER_ADMIN)
export class IntegrationProvidersController {
  constructor(private readonly service: OrganizationIntegrationsService) {}
  @Get() list(@CurrentUser() actor: Actor) {
    return this.service.providers(actor, true);
  }
  @Patch(':provider')
  @BodySchema(providerToggle)
  toggle(
    @CurrentUser() actor: Actor,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ) {
    return this.service.toggle(
      actor,
      parse(z.enum(providerIds), provider),
      parse(providerToggle, body).enabled,
    );
  }
}
@Controller('organization/integrations')
@Roles(Role.HR_ADMIN)
export class OrganizationIntegrationsController {
  constructor(private readonly service: OrganizationIntegrationsService) {}
  @Get('providers') providers(@CurrentUser() actor: Actor) {
    return this.service.providers(actor);
  }
  @Get() list(@CurrentUser() actor: Actor) {
    return this.service.list(actor);
  }
  @Post()
  @BodySchema(connectionSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  connect(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.service.connect(actor, parse(connectionSchema, body));
  }
  @Post('oauth/start')
  @BodySchema(connectionSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  start(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.service.startOAuth(actor, parse(connectionSchema, body));
  }
  @Post('oauth/complete')
  @BodySchema(oauthCompleteSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  complete(@CurrentUser() actor: Actor, @Body() body: unknown) {
    const b = parse(oauthCompleteSchema, body);
    return this.service.completeOAuth(actor, b.state, b.code);
  }
  @Post(':id/test')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  test(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.test(actor, id);
  }
  @Post(':id/enable') enable(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.enable(actor, id);
  }
  @Delete(':id') disconnect(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.disconnect(actor, id);
  }
}
