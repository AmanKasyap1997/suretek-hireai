import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { Roles } from '../../../shared/roles.decorator';
import { employeeListSchema } from './employees.schemas';
import { EmployeesService } from './employees.service';

@ApiTags('Core HR')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller()
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get('employees')
  @ApiOperation({ operationId: 'HrController_list', summary: undefined })
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.employees.list(actor, parse(employeeListSchema, query));
  }

  @Get('employees/:id')
  @ApiOperation({ operationId: 'HrController_get', summary: undefined })
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.employees.get(actor, id);
  }
}
