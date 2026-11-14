import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Param,
  ParseUUIDPipe,
  Post,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DbService } from '../database/db.service';
import { Actor, CurrentUser } from '../common/actor';
import { Role } from '../common/enums';
import { ADMIN_ROLES, ALL_ROLES } from './role-groups';
import { BodySchema, parse } from '../common/validation';
import { audit } from '../common/audit';
import { readConfig } from '../common/config';
import { Roles, Public } from './roles.decorator';
import { hashPassword, verifyPassword } from './password';
const email = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((v) => v.toLowerCase());
const loginSchema = z
  .object({
    tenantId: z.string().uuid(),
    email,
    password: z.string().min(1).max(1024),
  })
  .strict();
const createUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email,
    password: z.string().min(12).max(128),
    role: z.enum(Role),
  })
  .strict();
const userStatusSchema = z.object({ active: z.boolean() }).strict();
@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword('unused-dummy-login-verification');
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}
  async login(input: z.infer<typeof loginSchema>) {
    const user = await this.db.one(
      'SELECT id,tenant_id,password_hash,active FROM users WHERE tenant_id=$1 AND lower(email)=$2',
      [input.tenantId, input.email],
    );
    const verified = await verifyPassword(
      input.password,
      user?.password_hash ?? (await this.dummyHash),
    );
    if (!user?.active || !verified)
      throw new UnauthorizedException('Invalid credentials');
    const expiresIn = readConfig().JWT_EXPIRES_IN_SECONDS;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: user.tenant_id },
      {
        expiresIn,
        algorithm: 'HS256',
        issuer: 'suretek-hireai',
        audience: 'suretek-api',
      },
    );
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }
}
@ApiTags('Authentication and users')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DbService,
  ) {}
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
    return this.db.one(
      'SELECT id,tenant_id,full_name,email,role,active FROM users WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, actor.userId],
    );
  }
  @Post('users')
  @Roles(...ADMIN_ROLES)
  @BodySchema(createUserSchema)
  async createUser(@CurrentUser() actor: Actor, @Body() body: unknown) {
    const input = parse(createUserSchema, body);
    if (actor.role !== Role.SUPER_ADMIN && ADMIN_ROLES.includes(input.role))
      throw new ForbiddenException(
        'Only a super admin can create administrator accounts',
      );
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const user = await tx.one(
        'INSERT INTO users(tenant_id,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,$5) RETURNING id,tenant_id,email,full_name,role,active',
        [actor.tenantId, input.email, hash, input.fullName, input.role],
      );
      await audit(tx, actor, 'user.created', 'user', user!.id, {
        role: input.role,
      });
      return user;
    });
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
    if (id === actor.userId)
      throw new ForbiddenException(
        'Use another administrator to change your account status',
      );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        actor.tenantId,
      ]);
      const target = await tx.one<{ id: string; role: Role }>(
        'SELECT id,role FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!target) throw new NotFoundException('User not found');
      if (actor.role !== Role.SUPER_ADMIN && ADMIN_ROLES.includes(target.role))
        throw new ForbiddenException();
      if (target.role === Role.SUPER_ADMIN && !input.active) {
        const remaining = await tx.one(
          'SELECT count(*)::int AS count FROM users WHERE tenant_id=$1 AND role=$2 AND active=true AND id<>$3',
          [actor.tenantId, Role.SUPER_ADMIN, id],
        );
        if (!remaining?.count)
          throw new ForbiddenException('Keep at least one active super admin');
      }
      const row = await tx.one(
        'UPDATE users SET active=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id,email,full_name,role,active',
        [actor.tenantId, id, input.active],
      );
      await audit(tx, actor, 'user.status_changed', 'user', id, {
        active: input.active,
      });
      return row;
    });
  }
}
