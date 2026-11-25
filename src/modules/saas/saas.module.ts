import {
  LinkedInController,
  LinkedInSetupController,
} from '../organization-integrations/linkedin.controller';
import { LinkedInService } from '../organization-integrations/linkedin.service';
import { JobPublishingController } from '../organization-integrations/job-publishing.controller';
import { AiSettingsController } from '../organization-integrations/ai-settings.controller';
import { OrganizationAiService } from '../organization-integrations/organization-ai';
import { JobPublishingService } from '../organization-integrations/job-publishing.service';
import {
  IntegrationProvidersController,
  OrganizationIntegrationsController,
} from '../organization-integrations/organization-integrations.controller';
import { OrganizationIntegrationsService } from '../organization-integrations/organization-integrations.service';
import { SuperAdminController } from '../super-admin/super-admin.controller';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations';
import { SaasController } from './saas.controller';
import { SaasService } from './saas.service';
@Module({
  imports: [IntegrationsModule],
  controllers: [
    SaasController,
    SuperAdminController,
    IntegrationProvidersController,
    OrganizationIntegrationsController,
    LinkedInController,
    LinkedInSetupController,
    JobPublishingController,
    AiSettingsController,
  ],
  providers: [
    SaasService,
    SuperAdminService,
    OrganizationIntegrationsService,
    LinkedInService,
    JobPublishingService,
    OrganizationAiService,
  ],
  exports: [SaasService],
})
export class SaasModule {}
