import { Request, Response } from 'express';
import {
  assertBrowserOrigin,
  SESSION_COOKIE,
  sessionCookieOptions,
} from './browser-session';
import {
  Body,
  Delete,
  Req,
  Res,
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

  @Post('session')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @BodySchema(loginSchema)
  async browserLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertBrowserOrigin(req);
    const session = await this.auth.login(parse(loginSchema, body));
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(SESSION_COOKIE, session.accessToken, {
      ...sessionCookieOptions(),
      maxAge: session.expiresIn * 1000,
    });
    return { expiresIn: session.expiresIn };
  }

  @Get('session')
  @Roles(...ALL_ROLES)
  async browserSession(
    @CurrentUser() actor: Actor,
    @Req() req: Request & { sessionExpiresAt: number },
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return { user: await this.auth.me(actor), expiresAt: req.sessionExpiresAt };
  }

  @Delete('session')
  @Public()
  @HttpCode(204)
  browserLogout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertBrowserOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
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
