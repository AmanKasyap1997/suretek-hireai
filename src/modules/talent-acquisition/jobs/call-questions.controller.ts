import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { BodySchema, parse } from '../../../platform/http/validation';
import { callQuestionDraftSchema } from './call-questions';
import { CallQuestionsService } from './call-questions.service';

@ApiTags('Jobs')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('jobs/call-questions')
export class CallQuestionsController {
  constructor(private readonly service: CallQuestionsService) {}

  @Get('settings')
  @ApiOperation({
    summary:
      'Whether AI calling is on (so jobs have call questions) and whether an AI provider can draft them.',
  })
  settings(@CurrentUser() actor: Actor) {
    return this.service.settings(actor);
  }

  @Post()
  @HttpCode(200)
  @BodySchema(callQuestionDraftSchema)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Draft the questions a job’s AI call asks, for the recruiter to review. They are not saved.',
  })
  generate(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.service.generate(actor, parse(callQuestionDraftSchema, body));
  }
}
