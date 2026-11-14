import { Module } from '@nestjs/common';
import {
  ApplicationsController,
  CandidatesController,
  JobsController,
  OffersController,
} from './hiring.controller';
import { HiringService } from './hiring.service';

@Module({
  controllers: [
    JobsController,
    CandidatesController,
    ApplicationsController,
    OffersController,
  ],
  providers: [HiringService],
})
export class HiringModule {}
