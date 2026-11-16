import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RECRUITMENT_ROLES } from '../auth/role-groups';
import { Actor, CurrentUser } from '../common/actor';
import { BodySchema, parse } from '../common/validation';
import {
  callRequestSchema,
  callingPaginationSchema,
  consentSchema,
} from './calling.schemas';
import { CallingService } from './calling.service';

@ApiTags('Consent and call planning')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller()
export class CallingController {
  constructor(private readonly calling: CallingService) {}

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
      'Plan a local request after eligibility, consent and window checks; never dials',
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
  cancelCall(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) requestId: string,
  ) {
    return this.calling.cancelCall(actor, requestId);
  }
}
