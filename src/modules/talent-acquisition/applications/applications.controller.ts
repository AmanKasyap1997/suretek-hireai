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
