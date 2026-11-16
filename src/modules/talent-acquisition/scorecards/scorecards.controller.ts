import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BodySchema, parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { INTERVIEW_ROLES } from '../../../shared/ta-policy';
import { Roles } from '../../../shared/roles.decorator';
import { submitScorecardSchema } from './scorecards.schemas';
import { ScorecardsService } from './scorecards.service';

@ApiTags('Interview scorecards')
@ApiBearerAuth()
@Roles(...INTERVIEW_ROLES)
@Controller('interviews/:interviewId/scorecards')
export class ScorecardsController {
  constructor(private readonly scorecards: ScorecardsService) {}

  @Post()
  @BodySchema(submitScorecardSchema)
  @ApiOperation({
    summary:
      'Submit an immutable scorecard as an assigned panelist; no hiring decision is made',
  })
  submit(
    @CurrentUser() actor: Actor,
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: unknown,
  ) {
    return this.scorecards.submit(
      actor,
      interviewId,
      parse(submitScorecardSchema, body),
    );
  }

  @Get()
  @ApiOperation({
    summary:
      'List scorecards; assigned hiring managers and interviewers see only their own submissions',
  })
  list(
    @CurrentUser() actor: Actor,
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
  ) {
    return this.scorecards.list(actor, interviewId);
  }
}
