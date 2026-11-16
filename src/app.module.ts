import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule, AuthGuard } from './modules/auth';
import { DatabaseModule } from './platform/database/database.module';
import { TalentAcquisitionModule } from './modules/talent-acquisition';
import { HrModule } from './modules/hr';
import { PlatformHttpModule } from './platform/http/platform.module';
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    TalentAcquisitionModule,
    HrModule,
    PlatformHttpModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
