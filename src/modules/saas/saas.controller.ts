import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Actor, Role } from '../../shared/actor';
import { Public, Roles } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import { assertBrowserOrigin } from '../auth';
import { SaasService } from './saas.service';
import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteStaffSchema,
  listSchema,
  staffRolesSchema,
} from './saas.schemas';
@ApiTags('SaaS organizations and invitations')
@ApiBearerAuth()
@Controller('saas')
export class SaasController {
  constructor(private readonly saas: SaasService) {}
  @Get('organizations')
  @Roles(Role.SUPER_ADMIN)
  organizations(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.saas.organizations(actor, parse(listSchema, query));
  }
  @Post('organizations')
  @Roles(Role.SUPER_ADMIN)
  @BodySchema(createOrganizationSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.saas.createOrganization(
      actor,
      parse(createOrganizationSchema, body),
    );
  }
  @Post('organizations/:id/admin-invitation')
  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resendAdmin(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saas.resendOrganizationAdmin(actor, id);
  }
  @Patch('users/:id/roles')
  @Roles(Role.HR_ADMIN)
  @BodySchema(staffRolesSchema)
  changeRoles(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.saas.changeRoles(
      actor,
      id,
      parse(staffRolesSchema, body).roles,
    );
  }
  @Get('users')
  @Roles(Role.HR_ADMIN)
  users(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.saas.users(actor, parse(listSchema, query));
  }
  @Post('invitations')
  @Roles(Role.HR_ADMIN)
  @BodySchema(inviteStaffSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  invite(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.saas.inviteStaff(actor, parse(inviteStaffSchema, body));
  }
  @Post('users/:id/invitation')
  @Roles(Role.HR_ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resend(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.saas.resendStaff(actor, id);
  }
  @Post('invitations/accept')
  @Public()
  @HttpCode(200)
  @BodySchema(acceptInvitationSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  accept(@Body() body: unknown, @Req() req: Request) {
    assertBrowserOrigin(req);
    return this.saas.accept(parse(acceptInvitationSchema, body));
  }
}
