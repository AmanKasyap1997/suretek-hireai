import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { PrivacyService } from './privacy.service';
import { PrivacyController } from './privacy.controller';
@Module({
  imports: [IntegrationsModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
