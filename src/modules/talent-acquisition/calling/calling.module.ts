import { Module } from '@nestjs/common';
import { CallingController } from './calling.controller';
import { CallingService } from './calling.service';
import { CallingClock } from './calling.clock';

@Module({
  controllers: [CallingController],
  providers: [CallingService, CallingClock],
  exports: [CallingService, CallingClock],
})
export class CallingModule {}
