import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../shared/roles.decorator';
import { ADMIN_ROLES, RECRUITMENT_ROLES } from '../../shared/role-groups';
import { Actor, CurrentUser } from '../../shared/actor';
import { parse, paginationSchema } from './validation';
import { PlatformService } from './platform.service';

@ApiTags('Reporting and audit')
@ApiBearerAuth()
@Controller()
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('reports/hiring-summary')
  @Roles(...RECRUITMENT_ROLES)
  async summary(@CurrentUser() actor: Actor) {
    return this.platform.summary(actor);
  }

  @Get('audit-events')
  @Roles(...ADMIN_ROLES)
  async audit(@CurrentUser() actor: Actor, @Query() query: unknown) {
    const p = parse(paginationSchema, query);
    return this.platform.audit(actor, p);
  }
}
