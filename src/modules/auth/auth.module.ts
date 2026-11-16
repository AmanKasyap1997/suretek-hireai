import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { readConfig } from '../common/config';
import { AuthController, AuthService } from './auth.controller';
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: readConfig().JWT_SECRET }),
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
