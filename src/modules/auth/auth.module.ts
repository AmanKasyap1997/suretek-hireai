import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { readConfig } from '../../platform/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: readConfig().JWT_SECRET }),
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
