import { Module } from '@nestjs/common';
import { AccessPolicy } from '../../../shared/ta-policy';
import { ScorecardsController } from './scorecards.controller';
import { ScorecardsService } from './scorecards.service';

@Module({
  controllers: [ScorecardsController],
  providers: [AccessPolicy, ScorecardsService],
  exports: [ScorecardsService],
})
export class ScorecardsModule {}
