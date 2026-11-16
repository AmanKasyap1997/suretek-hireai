import { CareersModule } from './careers';
import { DocumentsModule } from './documents';
import { PrivacyModule } from './privacy';
import { Module } from '@nestjs/common';
import { JobsModule } from './jobs';
import { CandidatesModule } from './candidates';
import { ApplicationsModule } from './applications';
import { OffersModule } from './offers';
import { CallingModule } from './calling';

@Module({
  imports: [
    CareersModule,
    DocumentsModule,
    PrivacyModule,
    JobsModule,
    CandidatesModule,
    ApplicationsModule,
    OffersModule,
    CallingModule,
  ],
  exports: [CallingModule, PrivacyModule],
})
export class TalentAcquisitionModule {}
