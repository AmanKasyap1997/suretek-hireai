import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  controllers: [HealthController, PlatformController],
  providers: [HealthService, PlatformService],
})
export class PlatformHttpModule {}
