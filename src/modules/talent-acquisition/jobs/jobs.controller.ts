import {
  Body,
  Delete,
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Role } from '../../../shared/enums';
import { Roles } from '../../../shared/roles.decorator';
import { ADMIN_ROLES, RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { JobStatus } from '../../../shared/enums';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  assignmentSchema,
  jobSchema,
  closeJobSchema,
  interviewSetupUpdateSchema,
  updateJobSchema,
  paginationSchema,
  sendBackSchema,
} from './jobs.schemas';
import { JobsService } from './jobs.service';

@ApiTags('Jobs')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('jobs')
export class JobsController {
  constructor(private readonly hiring: JobsService) {}

  /**
   * Hiring managers request jobs (HR Admins create them too); recruiters
   * work on them once approved.
   */
  @Post()
  @Roles(...ADMIN_ROLES, Role.HIRING_MANAGER)
  @BodySchema(jobSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createJob(actor, parse(jobSchema, body));
  }

  @Get()
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listJobs(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER, Role.INTERVIEWER)
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getJob(actor, id);
  }

  @Patch(':id')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  @BodySchema(updateJobSchema)
  update(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.updateJob(actor, id, parse(updateJobSchema, body));
  }

  @Put(':id/interview-setup')
  @BodySchema(interviewSetupUpdateSchema)
  @ApiOperation({
    summary:
      'How the AI books this job’s interviews on its booking call (null: a recruiter books them). Changeable until the job closes.',
  })
  interviewSetup(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.setInterviewSetup(
      actor,
      id,
      parse(interviewSetupUpdateSchema, body).interviewSetup,
    );
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Role.HIRING_MANAGER)
  @ApiOperation({
    summary:
      'Submit a draft for an HR Admin to approve (a hiring manager’s job request).',
  })
  submit(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.submitJob(actor, id);
  }

  @Post(':id/send-back')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  @BodySchema(sendBackSchema)
  @ApiOperation({
    summary: 'Send a job awaiting approval back to be changed, with a note.',
  })
  sendBack(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.sendBack(actor, id, parse(sendBackSchema, body).note);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(...ADMIN_ROLES)
  approve(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.transitionJob(actor, id, JobStatus.APPROVED);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publish the job in HireAI. POST /jobs/{id}/channels then posts it to enabled external channels.',
  })
  publish(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.transitionJob(actor, id, JobStatus.PUBLISHED);
  }

  @Post(':id/close')
  @HttpCode(200)
  @BodySchema(closeJobSchema)
  close(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.transitionJob(
      actor,
      id,
      JobStatus.CLOSED,
      parse(closeJobSchema, body ?? {}).closeReason,
    );
  }
  @Post(':id/assignments')
  @Roles(...ADMIN_ROLES)
  @BodySchema(assignmentSchema)
  assign(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.assign(actor, id, parse(assignmentSchema, body));
  }
  @Get(':id/assignments')
  assignments(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.hiring.assignments(actor, id);
  }

  @Delete(':id/assignments/:assignmentId')
  @Roles(...ADMIN_ROLES)
  unassign(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.hiring.unassign(actor, id, assignmentId);
  }
}
