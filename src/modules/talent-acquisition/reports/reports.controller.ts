import { Controller, Get, Query, applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { Roles } from '../../../shared/roles.decorator';
import { recruitmentReportQuerySchema } from './reports.schemas';
import { ReportsService } from './reports.service';

function ReportQuery(): MethodDecorator {
  return applyDecorators(
    ApiQuery({
      name: 'jobId',
      required: false,
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiQuery({
      name: 'from',
      required: false,
      description: 'Inclusive ISO timestamp; defaults to 30 days before to.',
      schema: { type: 'string', format: 'date-time' },
    }),
    ApiQuery({
      name: 'to',
      required: false,
      description:
        'Exclusive ISO timestamp; defaults to now. Maximum period: 366 days.',
      schema: { type: 'string', format: 'date-time' },
    }),
  );
}

@ApiTags('Recruitment reports')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('reports/recruitment')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('funnel')
  @ReportQuery()
  @ApiOperation({
    summary: 'Distinct applications entering each stage, by job and period',
  })
  funnel(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.reports.funnel(
      actor,
      parse(recruitmentReportQuerySchema, query),
    );
  }

  @Get('time-in-stage')
  @ReportQuery()
  @ApiOperation({
    summary: 'Observed nonterminal stage dwell, clipped to the report period',
  })
  timeInStage(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.reports.timeInStage(
      actor,
      parse(recruitmentReportQuerySchema, query),
    );
  }

  @Get('time-to-hire')
  @ReportQuery()
  @ApiOperation({
    summary: 'First APPLIED to first HIRED, with incomplete histories excluded',
  })
  timeToHire(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.reports.timeToHire(
      actor,
      parse(recruitmentReportQuerySchema, query),
    );
  }
}
