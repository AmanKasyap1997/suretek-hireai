import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { DocumentsModule } from '../documents';
import { CareersService } from './careers.service';
import { CareersController } from './careers.controller';
@Module({
  imports: [IntegrationsModule, DocumentsModule],
  providers: [CareersService],
  controllers: [CareersController],
  exports: [CareersService],
})
export class CareersModule {}
