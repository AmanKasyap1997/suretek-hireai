import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { CallingController } from './calling.controller';
import { CallingService } from './calling.service';
import { CallingClock } from './calling.clock';
import { CallDispatchService } from './call-dispatch.service';
import { CallMediaGateway } from './call-media.gateway';
import { CallRecordsService } from './call-records.service';
import { CallWebhooksController } from './call-webhooks.controller';
import { PhoneCallsService } from './phone-calls.service';
import { TestCallsService } from './test-calls.service';
import { CallAssessmentService } from './call-assessment.service';
import { OrganizationAiService } from '../../organization-integrations/organization-ai';
import { HiringAutomationService } from './hiring-automation.service';
import { InterviewBookingService } from './interview-booking';

@Module({
  imports: [IntegrationsModule],
  controllers: [CallingController, CallWebhooksController],
  providers: [
    CallingService,
    CallingClock,
    CallRecordsService,
    CallDispatchService,
    PhoneCallsService,
    TestCallsService,
    CallMediaGateway,
    CallAssessmentService,
    OrganizationAiService,
    InterviewBookingService,
    HiringAutomationService,
  ],
  exports: [
    CallingService,
    CallingClock,
    CallDispatchService,
    CallRecordsService,
    HiringAutomationService,
    CallAssessmentService,
  ],
})
export class CallingModule {}
