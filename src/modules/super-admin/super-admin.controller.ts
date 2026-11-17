import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser, Role } from '../../shared/actor';
import { Roles } from '../../shared/roles.decorator';
import { parse, BodySchema } from '../../platform/http/validation';
import { SaasService } from '../saas/saas.service';
import { createOrganizationSchema } from '../saas/saas.schemas';
import { SuperAdminService, csvCell } from './super-admin.service';
import {
  adminSchema,
  adminStatusSchema,
  deleteSchema,
  editOrganization,
  filters,
  integrationSchema,
  settingsSchema,
  statusSchema,
} from './super-admin.schemas';
@Controller('super-admin')
@Roles(Role.SUPER_ADMIN)
export class SuperAdminController {
  constructor(
    private readonly service: SuperAdminService,
    private readonly saas: SaasService,
  ) {}
  @Get('dashboard') dashboard(@CurrentUser() a: Actor) {
    return this.service.dashboard(a);
  }
  @Get('organizations') organizations(
    @CurrentUser() a: Actor,
    @Query() q: unknown,
  ) {
    return this.service.organizations(a, parse(filters, q));
  }
  @Post('organizations')
  @BodySchema(createOrganizationSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  create(@CurrentUser() a: Actor, @Body() b: unknown) {
    return this.saas.createOrganization(a, parse(createOrganizationSchema, b));
  }
  @Get('organizations/:id') detail(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(a, id);
  }
  @Patch('organizations/:id')
  @BodySchema(editOrganization)
  edit(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: unknown,
  ) {
    return this.service.edit(a, id, parse(editOrganization, b));
  }
  @Post('organizations/:id/status')
  @BodySchema(statusSchema)
  status(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: unknown,
  ) {
    const v = parse(statusSchema, b);
    return this.service.status(a, id, v.status, v.reason);
  }
  @Delete('organizations/:id')
  @BodySchema(deleteSchema)
  remove(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: unknown,
  ) {
    return this.service.status(
      a,
      id,
      'suspended',
      undefined,
      parse(deleteSchema, b).confirmation,
    );
  }
  @Post('organizations/:id/invitation')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resend(@CurrentUser() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.saas.resendOrganizationAdmin(a, id);
  }
  @Get('reports') reports(@CurrentUser() a: Actor) {
    return this.service.reports(a);
  }
  @Get('audit-logs') logs(@CurrentUser() a: Actor, @Query() q: unknown) {
    return this.service.logs(a, parse(filters, q));
  }
  @Get('audit-logs/export') async export(
    @CurrentUser() a: Actor,
    @Query() q: unknown,
    @Res() res: Response,
  ) {
    const f = parse(filters, q),
      rows = await this.service.logs(a, f);
    const keys = [
      'created_at',
      'actor_id',
      'action',
      'entity_type',
      'entity_id',
      'metadata',
      'ip',
      'user_agent',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-logs.csv"',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      [
        keys.join(','),
        ...rows.data.map((row) => keys.map((k) => csvCell(row[k])).join(',')),
      ].join('\r\n'),
    );
  }
  @Get('integrations') integrations(@CurrentUser() a: Actor) {
    return this.service.integrations(a);
  }
  @Post('integrations')
  @BodySchema(integrationSchema)
  saveIntegration(@CurrentUser() a: Actor, @Body() b: unknown) {
    return this.service.saveIntegration(a, parse(integrationSchema, b));
  }
  @Post('integrations/:id/test')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  test(@CurrentUser() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.testIntegration(a, id);
  }
  @Post('integrations/:id/enable') enable(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.enableIntegration(a, id);
  }
  @Get('settings') settings(@CurrentUser() a: Actor) {
    return this.service.settings(a);
  }
  @Patch('settings')
  @BodySchema(settingsSchema)
  saveSettings(@CurrentUser() a: Actor, @Body() b: unknown) {
    return this.service.saveSettings(a, parse(settingsSchema, b));
  }
  @Get('admins') admins(@CurrentUser() a: Actor) {
    return this.service.admins(a);
  }
  @Post('admins')
  @BodySchema(adminSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  addAdmin(@CurrentUser() a: Actor, @Body() b: unknown) {
    return this.service.addAdmin(a, parse(adminSchema, b));
  }
  @Patch('admins/:id')
  @BodySchema(adminStatusSchema)
  adminStatus(
    @CurrentUser() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: unknown,
  ) {
    return this.service.adminStatus(a, id, parse(adminStatusSchema, b).active);
  }
}
