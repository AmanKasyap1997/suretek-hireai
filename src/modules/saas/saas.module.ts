import { SuperAdminController } from '../super-admin/super-admin.controller';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations';
import { SaasController } from './saas.controller';
import { SaasService } from './saas.service';
@Module({
  imports: [IntegrationsModule],
  controllers: [SaasController, SuperAdminController],
  providers: [SaasService, SuperAdminService],
  exports: [SaasService],
})
export class SaasModule {}
