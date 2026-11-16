import { Module } from '@nestjs/common';
import { JobsModule } from './jobs';
import { CandidatesModule } from './candidates';
import { ApplicationsModule } from './applications';
import { OffersModule } from './offers';
import { CallingModule } from './calling';

@Module({
  imports: [
    JobsModule,
    CandidatesModule,
    ApplicationsModule,
    OffersModule,
    CallingModule,
  ],
  exports: [CallingModule],
})
export class TalentAcquisitionModule {}
