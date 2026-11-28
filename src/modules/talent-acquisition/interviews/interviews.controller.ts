import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../shared/roles.decorator';
import { ADMIN_ROLES, RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { Actor, CurrentUser } from '../../../shared/actor';
import { INTERVIEW_ROLES } from '../../../shared/ta-policy';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  addToCalendarSchema,
  cancelInterviewSchema,
  interviewCalendarSchema,
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

  /** The calendar invitations go out from; before ':id' too. */
  @Get('calendar')
  @Roles(...RECRUITMENT_ROLES)
  calendar(@CurrentUser() actor: Actor) {
    return this.interviews.calendarStatus(actor);
  }

  /** An HR Admin chooses the calendar interviews go in. */
  @Put('calendar')
  @Roles(...ADMIN_ROLES)
  @BodySchema(interviewCalendarSchema)
  chooseCalendar(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.interviews.chooseCalendar(
      actor,
      parse(interviewCalendarSchema, body).provider,
    );
  }

  /** Who can be on a panel; before ':id', which it would otherwise match. */
  @Get('panelists')
  @Roles(...RECRUITMENT_ROLES)
  panelists(@CurrentUser() actor: Actor) {
    return this.interviews.panelists(actor);
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

  /** Adds it to the connected calendar, or sends its event again. */
  @Post(':id/calendar')
  @Roles(...RECRUITMENT_ROLES)
  @HttpCode(200)
  @BodySchema(addToCalendarSchema)
  addToCalendar(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.interviews.addToCalendar(
      actor,
      id,
      parse(addToCalendarSchema, body ?? {}).calendarProvider,
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
