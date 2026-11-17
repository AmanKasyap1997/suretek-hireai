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
  ],
  providers: [SaasService, SuperAdminService, OrganizationIntegrationsService],
  exports: [SaasService],
})
export class SaasModule {}
