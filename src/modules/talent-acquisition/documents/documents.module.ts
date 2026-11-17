import { DocumentsScanService } from './documents-scan.service';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../../integrations';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
@Module({
  imports: [IntegrationsModule],
  providers: [DocumentsService, DocumentsScanService],
  controllers: [DocumentsController],
  exports: [DocumentsService, DocumentsScanService],
})
export class DocumentsModule {}
