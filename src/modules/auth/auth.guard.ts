import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { DbService } from '../../platform/database/db.service';
import { setTenantId } from '../../platform/database/tenant-context';
import { Actor } from '../../shared/actor';
import { Role } from '../../shared/enums';
import { PUBLIC_KEY, ROLES_KEY } from '../../shared/roles.decorator';

const claimsSchema = z.object({
  sub: z.string().uuid(),
  tenantId: z.string().uuid(),
});
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
    let token: z.infer<typeof claimsSchema>;
    try {
      token = claimsSchema.parse(
        await this.jwt.verifyAsync<Record<string, unknown>>(header.slice(7), {
          algorithms: ['HS256'],
          issuer: 'suretek-hireai',
          audience: 'suretek-api',
        }),
      );
    } catch {
      throw new UnauthorizedException();
    }
    setTenantId(token.tenantId);
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
