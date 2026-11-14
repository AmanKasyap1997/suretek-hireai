import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DbService, DbClient } from '../database/db.service';
import { Roles } from '../auth/roles.decorator';
import { ADMIN_ROLES } from '../auth/role-groups';
import { LeaveType, LeaveStatus } from '../common/enums';
import { Actor, CurrentUser } from '../common/actor';
import { audit } from '../common/audit';
import { BodySchema, parse, paginationSchema } from '../common/validation';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    'Invalid date',
  );
const leaveSchema = z
  .object({
    employeeId: z.string().uuid(),
    type: z.enum(LeaveType),
    startDate: date,
    endDate: date,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, 'End date must follow start date');
const reviewSchema = z
  .object({
    status: z
      .enum(LeaveStatus)
      .extract([LeaveStatus.APPROVED, LeaveStatus.REJECTED]),
  })
  .strict();
const attendanceSchema = z
  .object({
    employeeId: z.string().uuid(),
    workDate: date,
    checkIn: z.string().datetime({ offset: true }),
    checkOut: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (v) => !v.checkOut || Date.parse(v.checkOut) > Date.parse(v.checkIn),
    'Check out must follow check in',
  );
const completionSchema = z.object({ completed: z.boolean() }).strict();
@ApiTags('Core HR')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller()
export class HrController {
  constructor(private readonly db: DbService) {}
  private async employee(db: DbClient, actor: Actor, id: string) {
    const row = await db.one(
      'SELECT * FROM employees WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, id],
    );
    if (!row) throw new NotFoundException('Employee not found');
    return row;
  }
  @Get('employees')
  async list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    const p = parse(paginationSchema, query);
    return {
      data: await this.db.query(
        'SELECT * FROM employees WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
  @Get('employees/:id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.employee(this.db, actor, id);
  }
  @Get('employees/:id/onboarding-tasks')
  async tasks(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.employee(this.db, actor, id);
    return {
      data: await this.db.query(
        'SELECT * FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2 ORDER BY created_at,id',
        [actor.tenantId, id],
      ),
    };
  }
  @Patch('onboarding-tasks/:id')
  @BodySchema(completionSchema)
  async complete(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(completionSchema, body);
    return this.db.transaction(async (tx) => {
      const row = await tx.one(
        'UPDATE onboarding_tasks SET completed=$3 WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, input.completed],
      );
      if (!row) throw new NotFoundException();
      await audit(tx, actor, 'onboarding.task_updated', 'onboarding_task', id, {
        completed: input.completed,
      });
      return row;
    });
  }
  @Post('leave-requests')
  @BodySchema(leaveSchema)
  @ApiOperation({
    summary: 'HR records leave; balance/accrual policy is future work',
  })
  async leave(@CurrentUser() actor: Actor, @Body() body: unknown) {
    const v = parse(leaveSchema, body);
    return this.db.transaction(async (tx) => {
      await this.employee(tx, actor, v.employeeId);
      const row = await tx.one(
        'INSERT INTO leave_requests(tenant_id,employee_id,type,start_date,end_date,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          actor.tenantId,
          v.employeeId,
          v.type,
          v.startDate,
          v.endDate,
          v.reason,
          actor.userId,
        ],
      );
      await audit(tx, actor, 'leave.requested', 'leave_request', row!.id);
      return row;
    });
  }
  @Get('leave-requests')
  async leaves(@CurrentUser() actor: Actor, @Query() query: unknown) {
    const p = parse(paginationSchema, query);
    return {
      data: await this.db.query(
        'SELECT * FROM leave_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
  @Post('leave-requests/:id/review')
  @BodySchema(reviewSchema)
  async review(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const v = parse(reviewSchema, body);
    return this.db.transaction(async (tx) => {
      const current = await tx.one(
        'SELECT * FROM leave_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!current) throw new NotFoundException();
      if (current.status !== LeaveStatus.PENDING)
        throw new ConflictException('Leave has already been reviewed');
      const row = await tx.one(
        'UPDATE leave_requests SET status=$3,reviewed_by=$4 WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [actor.tenantId, id, v.status, actor.userId],
      );
      await audit(tx, actor, 'leave.reviewed', 'leave_request', id, {
        status: v.status,
      });
      return row;
    });
  }
  @Post('attendance')
  @BodySchema(attendanceSchema)
  @ApiOperation({
    summary: 'HR records one attendance entry per employee/work date',
  })
  async attendance(@CurrentUser() actor: Actor, @Body() body: unknown) {
    const v = parse(attendanceSchema, body);
    return this.db.transaction(async (tx) => {
      await this.employee(tx, actor, v.employeeId);
      const row = await tx.one(
        'INSERT INTO attendance(tenant_id,employee_id,work_date,check_in,check_out) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [
          actor.tenantId,
          v.employeeId,
          v.workDate,
          v.checkIn,
          v.checkOut ?? null,
        ],
      );
      await audit(tx, actor, 'attendance.recorded', 'attendance', row!.id);
      return row;
    });
  }
  @Get('attendance')
  async attendanceList(@CurrentUser() actor: Actor, @Query() query: unknown) {
    const p = parse(paginationSchema, query);
    return {
      data: await this.db.query(
        'SELECT * FROM attendance WHERE tenant_id=$1 ORDER BY work_date DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
}
