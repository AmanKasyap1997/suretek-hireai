import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Role } from '../../../shared/enums';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  applicationSchema,
  stageSchema,
  paginationSchema,
} from './applications.schemas';
import { ApplicationsService } from './applications.service';

@ApiTags('Applications')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly hiring: ApplicationsService) {}

  @Post()
  @BodySchema(applicationSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createApplication(actor, parse(applicationSchema, body));
  }

  @Get()
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listApplications(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getApplication(actor, id);
  }

  @Get(':id/details')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  @ApiOperation({
    summary:
      'What the candidate submitted. Pay and contact details are omitted for interviewers.',
  })
  details(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.details(actor, id);
  }

  @Patch(':id/stage')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  @BodySchema(stageSchema)
  @ApiOperation({
    summary:
      'Record a human stage decision; HIRED is only set by the offer-to-employee transaction.',
  })
  stage(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.changeStage(actor, id, parse(stageSchema, body));
  }
  @Get(':id/history')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  history(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.history(actor, id);
  }
}
