import { AccessPolicy } from '../../../shared/ta-policy';
import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  controllers: [ApplicationsController],
  providers: [AccessPolicy, ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
