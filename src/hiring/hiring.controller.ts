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
import { Actor, CurrentUser } from '../common/actor';
import { Roles } from '../auth/roles.decorator';
import { ADMIN_ROLES, RECRUITMENT_ROLES } from '../auth/role-groups';
import { JobStatus } from '../common/enums';
import { BodySchema, parse } from '../common/validation';
import {
  acceptOfferSchema,
  applicationSchema,
  candidateSchema,
  jobSchema,
  offerSchema,
  paginationSchema,
  stageSchema,
  updateJobSchema,
} from './hiring.schemas';
import { HiringService } from './hiring.service';

@ApiTags('Jobs')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('jobs')
export class JobsController {
  constructor(private readonly hiring: HiringService) {}

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

@ApiTags('Candidates')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('candidates')
export class CandidatesController {
  constructor(private readonly hiring: HiringService) {}

  @Post()
  @BodySchema(candidateSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createCandidate(actor, parse(candidateSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listCandidates(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getCandidate(actor, id);
  }
}

@ApiTags('Applications')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly hiring: HiringService) {}

  @Post()
  @BodySchema(applicationSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createApplication(actor, parse(applicationSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listApplications(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getApplication(actor, id);
  }

  @Patch(':id/stage')
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
}

@ApiTags('Offers')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('offers')
export class OffersController {
  constructor(private readonly hiring: HiringService) {}

  @Post()
  @BodySchema(offerSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createOffer(actor, parse(offerSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listOffers(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getOffer(actor, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.approveOffer(actor, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @BodySchema(acceptOfferSchema)
  @ApiOperation({
    summary:
      'HR records verified candidate acceptance with an evidence reference; this is not an e-signature.',
  })
  accept(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(acceptOfferSchema, body);
    return this.hiring.acceptOffer(actor, id, input.acceptanceReference);
  }

  @Post(':id/hire')
  @ApiOperation({
    summary:
      'Create one employee and onboarding checklist from an accepted offer; safe to retry.',
  })
  hire(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.hire(actor, id);
  }
}
