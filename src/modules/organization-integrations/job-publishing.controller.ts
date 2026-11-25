import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, CurrentUser, Role } from '../../shared/actor';
import { Roles } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import {
  jobChannelsSchema,
  removableChannelSchema,
} from './job-publishing.schemas';
import { JobPublishingService } from './job-publishing.service';

// Under /jobs so the hiring-module gate applies. Multi-segment paths never
// collide with the parameterised GET /jobs/:id route.
@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
@Roles(Role.HR_ADMIN)
export class JobPublishingController {
  constructor(private readonly service: JobPublishingService) {}

  @Get('publishing/channels')
  @ApiOperation({
    summary: 'External channels enabled for posting published jobs.',
  })
  channels(@CurrentUser() actor: Actor) {
    return this.service.channels(actor);
  }

  @Get(':id/channels')
  history(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(actor, id);
  }

  @Post(':id/channels')
  @HttpCode(200)
  @BodySchema(jobChannelsSchema)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Post a published job to the careers website and LinkedIn channels.',
  })
  publish(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.publish(actor, id, parse(jobChannelsSchema, body));
  }

  @Delete(':id/channels/:channel')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Delete the job’s LinkedIn post so it can be posted again. Safe to repeat.',
  })
  remove(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('channel') channel: string,
  ) {
    return this.service.remove(
      actor,
      id,
      parse(removableChannelSchema, channel),
    );
  }
}
