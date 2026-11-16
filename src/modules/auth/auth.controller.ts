import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../shared/actor';
import { ADMIN_ROLES, ALL_ROLES } from '../../shared/role-groups';
import { Roles, Public } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import { AuthService } from './auth.service';
import {
  createUserSchema,
  loginSchema,
  userStatusSchema,
} from './auth.schemas';

@ApiTags('Authentication and users')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @BodySchema(loginSchema)
  login(@Body() body: unknown) {
    return this.auth.login(parse(loginSchema, body));
  }

  @Get('me')
  @Roles(...ALL_ROLES)
  me(@CurrentUser() actor: Actor) {
    return this.auth.me(actor);
  }

  @Post('users')
  @Roles(...ADMIN_ROLES)
  @BodySchema(createUserSchema)
  async createUser(@CurrentUser() actor: Actor, @Body() body: unknown) {
    const input = parse(createUserSchema, body);
    return this.auth.createUser(actor, input);
  }

  @Patch('users/:id/status')
  @Roles(...ADMIN_ROLES)
  @BodySchema(userStatusSchema)
  async setStatus(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(userStatusSchema, body);
    return this.auth.setStatus(actor, id, input);
  }
}
