import { Module } from '@nestjs/common';
import { AccessPolicy } from '../../../shared/ta-policy';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';
import { InterviewCalendarService } from './interview-calendar';

@Module({
  controllers: [InterviewsController],
  providers: [InterviewsService, InterviewCalendarService, AccessPolicy],
  exports: [InterviewsService, InterviewCalendarService],
})
export class InterviewsModule {}
