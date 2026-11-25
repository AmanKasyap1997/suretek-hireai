import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { AccessPolicy } from '../../../shared/ta-policy';
import { OrganizationAiService } from '../../organization-integrations/organization-ai';
import { ScreeningController } from './screening.controller';
import { ScreeningService } from './screening.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [ScreeningController],
  providers: [AccessPolicy, OrganizationAiService, ScreeningService],
  exports: [ScreeningService],
})
export class ScreeningModule {}
