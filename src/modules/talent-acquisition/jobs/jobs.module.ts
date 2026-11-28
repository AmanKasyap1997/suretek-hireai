import { AccessPolicy } from '../../../shared/ta-policy';
import { Module } from '@nestjs/common';
import { OrganizationAiService } from '../../organization-integrations/organization-ai';
import { CallQuestionsController } from './call-questions.controller';
import { CallQuestionsService } from './call-questions.service';
import { JobDescriptionController } from './job-description.controller';
import { JobDescriptionService } from './job-description.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  // Static AI routes are registered before the parameterised job routes.
  controllers: [
    JobDescriptionController,
    CallQuestionsController,
    JobsController,
  ],
  providers: [
    AccessPolicy,
    JobsService,
    JobDescriptionService,
    CallQuestionsService,
    OrganizationAiService,
  ],
  exports: [JobsService],
})
export class JobsModule {}
