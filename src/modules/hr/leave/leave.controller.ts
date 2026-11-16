import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BodySchema, parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { Roles } from '../../../shared/roles.decorator';
import { leaveListSchema, leaveSchema, reviewSchema } from './leave.schemas';
import { LeaveService } from './leave.service';

@ApiTags('Core HR')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller()
export class LeaveController {
  constructor(private readonly leaveRequests: LeaveService) {}

  @Post('leave-requests')
  @BodySchema(leaveSchema)
  @ApiOperation({
    operationId: 'HrController_leave',
    summary: 'HR records leave; balance/accrual policy is future work',
  })
  leave(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.leaveRequests.create(actor, parse(leaveSchema, body));
  }

  @Get('leave-requests')
  @ApiOperation({ operationId: 'HrController_leaves', summary: undefined })
  leaves(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.leaveRequests.list(actor, parse(leaveListSchema, query));
  }

  @Post('leave-requests/:id/review')
  @BodySchema(reviewSchema)
  @ApiOperation({ operationId: 'HrController_review', summary: undefined })
  review(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.leaveRequests.review(actor, id, parse(reviewSchema, body));
  }
}
