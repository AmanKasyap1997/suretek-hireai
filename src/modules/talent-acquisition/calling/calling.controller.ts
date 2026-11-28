import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { Role } from '../../../shared/enums';
import { Actor, CurrentUser } from '../../../shared/actor';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  callRequestSchema,
  callingPaginationSchema,
  consentSchema,
  jobCallsSchema,
} from './calling.schemas';
import { CallingService } from './calling.service';
import { CallRecordsService } from './call-records.service';
import { TestCallsService, testCallSchema } from './test-calls.service';

@ApiTags('Consent and AI calls')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller()
export class CallingController {
  constructor(
    private readonly calling: CallingService,
    private readonly records: CallRecordsService,
    private readonly tests: TestCallsService,
  ) {}

  @Post('candidates/:id/consents')
  @ApiOperation({
    summary:
      'Append a staff-recorded consent or revocation, with evidence reference',
  })
  @BodySchema(consentSchema)
  recordConsent(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) candidateId: string,
    @Body() body: unknown,
  ) {
    return this.calling.recordConsent(
      actor,
      candidateId,
      parse(consentSchema, body),
    );
  }

  @Get('candidates/:id/consents')
  listConsents(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) candidateId: string,
    @Query() query: unknown,
  ) {
    return this.calling.listConsents(
      actor,
      candidateId,
      parse(callingPaginationSchema, query),
    );
  }

  @Post('call-requests')
  @ApiOperation({
    summary:
      'Ask for an AI call after eligibility and consent checks. HireAI dials during calling hours and checks again before dialing.',
  })
  @BodySchema(callRequestSchema)
  planCall(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.calling.planCall(actor, parse(callRequestSchema, body));
  }

  @Get('call-requests')
  listCalls(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.calling.listCalls(actor, parse(callingPaginationSchema, query));
  }

  @Post('call-requests/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a waiting call, or hang up one that is on the line',
  })
  cancelCall(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) requestId: string,
  ) {
    return this.calling.cancelCall(actor, requestId);
  }

  @Get('applications/:id/calls')
  @ApiOperation({
    summary:
      'Whether the candidate can be called now, their consents, and the application’s calls with answers',
  })
  applicationCalls(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) applicationId: string,
  ) {
    return this.calling.applicationCalls(actor, applicationId);
  }

  @Post('jobs/:id/calls')
  @ApiOperation({
    summary:
      'Call every shortlisted candidate of the job who agreed to be called and has not been called',
  })
  @BodySchema(jobCallsSchema)
  callJob(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) jobId: string,
    @Body() body: unknown,
  ) {
    return this.calling.callJob(actor, jobId, parse(jobCallsSchema, body));
  }

  @Get('call-requests/:id/attempts/:attemptId/recording')
  @ApiOperation({
    summary: 'A call recording (WAV), when the candidate agreed',
  })
  async recording(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) requestId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ) {
    const bytes = await this.records.recording(actor, requestId, attemptId);
    return new StreamableFile(bytes, {
      type: 'audio/wav',
      disposition: 'inline; filename="call-recording.wav"',
      length: bytes.length,
    });
  }

  @Post('call-requests/:id/attempts/:attemptId/assessment')
  @ApiOperation({
    summary:
      'Assess a call’s answers again with the screening AI (a suggestion; never changes a stage)',
  })
  reassess(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) requestId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ) {
    return this.records.reassess(actor, requestId, attemptId);
  }

  @Post('calls/test-sessions')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Start a browser test call with a job’s questions; returns a one-time ticket for the audio WebSocket',
  })
  @BodySchema(testCallSchema)
  testCall(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.tests.create(actor, parse(testCallSchema, body));
  }
}
