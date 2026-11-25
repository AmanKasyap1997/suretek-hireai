import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Role } from '../../../shared/enums';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { ScreeningService } from './screening.service';

@ApiTags('Screening')
@ApiBearerAuth()
@Controller()
export class ScreeningController {
  constructor(private readonly screening: ScreeningService) {}

  @Get('applications/:id/screening')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  @ApiOperation({
    summary:
      'The newest AI resume screening of an application, or null. Advice for a recruiter; it never changes the stage.',
  })
  current(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.screening.current(actor, id);
  }

  @Post('applications/:id/screening')
  @Roles(...RECRUITMENT_ROLES)
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Screen the application’s resume now with the organization’s AI provider and return the result.',
  })
  screen(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.screening.screenNow(actor, id);
  }

  @Get('jobs/:id/screening')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  @ApiOperation({
    summary: 'Screening progress for the job’s applications.',
  })
  summary(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.screening.summary(actor, id);
  }

  @Post('jobs/:id/screening')
  @Roles(...RECRUITMENT_ROLES)
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Queue screening for the job’s unscreened or failed applications that are applied or shortlisted (up to 100).',
  })
  screenJob(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.screening.screenJob(actor, id);
  }
}
