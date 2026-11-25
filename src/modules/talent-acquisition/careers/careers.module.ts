import { ContactVerificationService } from './contact-verification.service';
import { ContactVerificationController } from './contact-verification.controller';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { DocumentsModule } from '../documents';
import { ScreeningModule } from '../screening';
import { CareersService } from './careers.service';
import { CareersController } from './careers.controller';
@Module({
  imports: [IntegrationsModule, DocumentsModule, ScreeningModule],
  providers: [CareersService, ContactVerificationService],
  controllers: [CareersController, ContactVerificationController],
  exports: [CareersService],
})
export class CareersModule {}
