import { cookieToken, assertBrowserOrigin } from './browser-session';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  HttpException,
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
  exp: z.number(),
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
    ) {
      const req = ctx.switchToHttp().getRequest();
      if (req.params?.tenantSlug) {
        const resolved = await this.db.one(
          'SELECT resolve_public_tenant($1) AS id',
          [req.params.tenantSlug],
        );
        if (resolved?.id) {
          setTenantId(resolved.id);
          const tenant = await this.db.one(
            'SELECT status,deleted_at,enabled_modules FROM tenants WHERE id=$1',
            [resolved.id],
          );
          if (
            !tenant ||
            tenant.status === 'suspended' ||
            tenant.deleted_at ||
            !tenant.enabled_modules.includes('hiring')
          )
            throw new ForbiddenException('Organization hiring is unavailable');
        }
      }
      return true;
    }
    const request = ctx.switchToHttp().getRequest();
    const cookie = cookieToken(request);
    const header =
      request.headers.authorization ??
      (cookie ? `Bearer ${cookie}` : undefined);
    if (
      !request.headers.authorization &&
      cookie &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    )
      assertBrowserOrigin(request);
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
      must_change_password: boolean;
      roles: Role[];
    }>(
      'SELECT id,tenant_id,role,must_change_password,ARRAY(SELECT role FROM user_roles WHERE user_id=users.id AND tenant_id=users.tenant_id) AS roles FROM users WHERE id=$1 AND tenant_id=$2 AND active=true',
      [token.sub, token.tenantId],
    );
    if (!user) throw new UnauthorizedException();
    const tenant = await this.db.one(
      'SELECT status,deleted_at,enabled_modules,is_platform FROM tenants WHERE id=$1',
      [token.tenantId],
    );
    if (!tenant || tenant.status === 'suspended' || tenant.deleted_at)
      throw new HttpException(
        'Organization is suspended. Contact your administrator.',
        423,
      );
    const path = String(request.route?.path ?? request.path).toLowerCase().replace('/api/v1/', '').replace(/\/+$/, '');
    if (
      user.must_change_password &&
      !['auth/password', 'auth/me', 'auth/session'].includes(path)
    )
      throw new ForbiddenException(
        'Change your initial password before continuing',
      );
    const module = path.includes('onboarding')
      ? 'onboarding'
      : path.startsWith('employees')
        ? 'core_hr'
        : path.includes('leave')
          ? 'leave'
          : path.includes('attendance')
            ? 'attendance'
            : /^(jobs|applications|candidates|interviews|offers|reports|call-requests)/.test(
                  path,
                )
              ? 'hiring'
              : null;
    if (module && !tenant.enabled_modules.includes(module))
      throw new ForbiddenException(
        'This module is disabled for your organization',
      );
    if (
      path.startsWith('super-admin') &&
      (!tenant.is_platform || user.role !== Role.SUPER_ADMIN)
    )
      throw new ForbiddenException();
    const policy = await this.db.one(
      "SELECT value FROM platform_settings WHERE key='defaults'",
    );
    if (
      policy?.value.emergency_pause &&
      path === 'call-requests' &&
      request.method === 'POST'
    )
      throw new ForbiddenException('Calling is paused by the platform');
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (
      user.role === Role.SUPER_ADMIN &&
      !['auth', 'saas', 'super-admin'].includes(path.split('/')[0])
    )
      throw new ForbiddenException();
    const effectiveRole = allowed?.includes(user.role)
      ? user.role
      : allowed?.find((role) => user.roles.includes(role));
    if (!effectiveRole) throw new ForbiddenException();
    request.sessionExpiresAt = token.exp * 1000;
    request.actor = {
      userId: user.id,
      tenantId: user.tenant_id,
      role: effectiveRole,
    } satisfies Actor;
    return true;
  }
}
