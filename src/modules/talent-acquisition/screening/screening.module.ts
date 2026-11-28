import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { CallingModule } from '../calling';
import { AccessPolicy } from '../../../shared/ta-policy';
import { OrganizationAiService } from '../../organization-integrations/organization-ai';
import { ScreeningController } from './screening.controller';
import { ScreeningService } from './screening.service';
import { WorkRecoveryService } from './work-recovery.service';

@Module({
  imports: [IntegrationsModule, CallingModule],
  controllers: [ScreeningController],
  providers: [
    AccessPolicy,
    OrganizationAiService,
    ScreeningService,
    WorkRecoveryService,
  ],
  exports: [ScreeningService, WorkRecoveryService],
})
export class ScreeningModule {}
