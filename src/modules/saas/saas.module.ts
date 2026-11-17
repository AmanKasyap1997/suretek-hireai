import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations';
import { SaasController } from './saas.controller';
import { SaasService } from './saas.service';
@Module({
  imports: [IntegrationsModule],
  controllers: [SaasController],
  providers: [SaasService],
  exports: [SaasService],
})
export class SaasModule {}
