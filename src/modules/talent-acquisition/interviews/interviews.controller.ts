import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { Actor, CurrentUser } from '../../../shared/actor';
import { INTERVIEW_ROLES } from '../../../shared/ta-policy';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  cancelInterviewSchema,
  createInterviewSchema,
  interviewListSchema,
  rescheduleInterviewSchema,
} from './interviews.schemas';
import { InterviewsService } from './interviews.service';

@ApiTags('Interviews')
@ApiBearerAuth()
@Roles(...INTERVIEW_ROLES)
@Controller('interviews')
export class InterviewsController {
  constructor(private readonly interviews: InterviewsService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.interviews.list(actor, parse(interviewListSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.interviews.get(actor, id);
  }

  @Post()
  @Roles(...RECRUITMENT_ROLES)
  @BodySchema(createInterviewSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.interviews.create(actor, parse(createInterviewSchema, body));
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_ROLES)
  @BodySchema(rescheduleInterviewSchema)
  reschedule(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.interviews.reschedule(
      actor,
      id,
      parse(rescheduleInterviewSchema, body),
    );
  }

  @Post(':id/cancel')
  @Roles(...RECRUITMENT_ROLES)
  @HttpCode(200)
  @BodySchema(cancelInterviewSchema)
  cancel(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(cancelInterviewSchema, body);
    return this.interviews.cancel(actor, id, input.reason);
  }
}
