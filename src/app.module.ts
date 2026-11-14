import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { DatabaseModule } from './database/database.module';
import { HiringModule } from './hiring/hiring.module';
import { CallingModule } from './calling/calling.module';
import { HrController } from './hr/hr.controller';
import {
  HealthController,
  PlatformController,
} from './common/platform.controller';
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    HiringModule,
    CallingModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
  ],
  controllers: [HrController, HealthController, PlatformController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
