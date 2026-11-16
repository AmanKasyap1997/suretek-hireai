import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
@Module({
  imports: [IntegrationsModule],
  providers: [DocumentsService],
  controllers: [DocumentsController],
  exports: [DocumentsService],
})
export class DocumentsModule {}
