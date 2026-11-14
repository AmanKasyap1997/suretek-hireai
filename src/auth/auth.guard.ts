import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DbService } from '../database/db.service';
import { Actor, Role } from '../common/actor';
import { PUBLIC_KEY, ROLES_KEY } from './roles.decorator';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: DbService,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const request = ctx.switchToHttp().getRequest();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw new UnauthorizedException();
    let token: { sub: string; tenantId: string };
    try {
      token = await this.jwt.verifyAsync(header.slice(7), {
        algorithms: ['HS256'],
        issuer: 'suretek-hireai',
        audience: 'suretek-api',
      });
    } catch {
      throw new UnauthorizedException();
    }
    if (!token.sub || !token.tenantId) throw new UnauthorizedException();
    const user = await this.db.one<{
      id: string;
      tenant_id: string;
      role: Role;
    }>(
      'SELECT id,tenant_id,role FROM users WHERE id=$1 AND tenant_id=$2 AND active=true',
      [token.sub, token.tenantId],
    );
    if (!user) throw new UnauthorizedException();
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!allowed?.includes(user.role)) throw new ForbiddenException();
    request.actor = {
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    } satisfies Actor;
    return true;
  }
}
