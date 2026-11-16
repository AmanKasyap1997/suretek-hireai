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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { ADMIN_ROLES, RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { JobStatus } from '../../../shared/enums';
import { BodySchema, parse } from '../../../platform/http/validation';
import { jobSchema, updateJobSchema, paginationSchema } from './jobs.schemas';
import { JobsService } from './jobs.service';

@ApiTags('Jobs')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('jobs')
export class JobsController {
  constructor(private readonly hiring: JobsService) {}

  @Post()
  @BodySchema(jobSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createJob(actor, parse(jobSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listJobs(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getJob(actor, id);
  }

  @Patch(':id')
  @BodySchema(updateJobSchema)
  update(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.hiring.updateJob(actor, id, parse(updateJobSchema, body));
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
      'Publish the internal job record; no external CMS/LinkedIn integration is enabled.',
  })
  publish(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.transitionJob(actor, id, JobStatus.PUBLISHED);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.transitionJob(actor, id, JobStatus.CLOSED);
  }
}
