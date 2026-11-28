import { CareersModule } from './careers';
import { DocumentsModule } from './documents';
import { PrivacyModule } from './privacy';
import { Module } from '@nestjs/common';
import { JobsModule } from './jobs';
import { CandidatesModule } from './candidates';
import { ApplicationsModule } from './applications';
import { OffersModule } from './offers';
import { CallingModule } from './calling';
import { ScorecardsModule } from './scorecards';
import { ReportsModule } from './reports';
import { InterviewsModule } from './interviews';
import { ScreeningModule } from './screening';

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
    ScorecardsModule,
    ReportsModule,
    InterviewsModule,
    ScreeningModule,
  ],
  exports: [CallingModule, PrivacyModule, DocumentsModule],
})
export class TalentAcquisitionModule {}
