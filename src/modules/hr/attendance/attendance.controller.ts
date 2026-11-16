import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BodySchema, parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { Roles } from '../../../shared/roles.decorator';
import { attendanceListSchema, attendanceSchema } from './attendance.schemas';
import { AttendanceService } from './attendance.service';

@ApiTags('Core HR')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller()
export class AttendanceController {
  constructor(private readonly attendanceRecords: AttendanceService) {}

  @Post('attendance')
  @BodySchema(attendanceSchema)
  @ApiOperation({
    operationId: 'HrController_attendance',
    summary: 'HR records one attendance entry per employee/work date',
  })
  attendance(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.attendanceRecords.record(actor, parse(attendanceSchema, body));
  }

  @Get('attendance')
  @ApiOperation({
    operationId: 'HrController_attendanceList',
    summary: undefined,
  })
  attendanceList(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.attendanceRecords.list(
      actor,
      parse(attendanceListSchema, query),
    );
  }
}
