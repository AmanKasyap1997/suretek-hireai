import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { BodySchema, parse } from '../../../platform/http/validation';
import { jobDescriptionSchema } from './jobs.schemas';
import { JobDescriptionService } from './job-description.service';

@ApiTags('Jobs')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('jobs/ai-description')
export class JobDescriptionController {
  constructor(private readonly service: JobDescriptionService) {}

  @Get('providers')
  @ApiOperation({
    summary:
      'AI providers the organization has connected, tested and enabled for drafting job descriptions.',
  })
  providers(@CurrentUser() actor: Actor) {
    return this.service.providers(actor);
  }

  @Post()
  @HttpCode(200)
  @BodySchema(jobDescriptionSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Draft a job description with the organization’s enabled AI provider. The draft is returned for review and is not saved.',
  })
  generate(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.service.generate(actor, parse(jobDescriptionSchema, body));
  }
}
