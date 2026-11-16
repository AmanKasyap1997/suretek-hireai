import { Module } from '@nestjs/common';
import { AccessPolicy } from '../../../shared/ta-policy';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';

@Module({
  controllers: [InterviewsController],
  providers: [InterviewsService, AccessPolicy],
  exports: [InterviewsService],
})
export class InterviewsModule {}
