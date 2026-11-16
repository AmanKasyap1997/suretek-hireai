import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../shared/roles.decorator';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live') live() {
    return this.health.live();
  }

  @Get('ready') async ready() {
    return this.health.ready();
  }
}
