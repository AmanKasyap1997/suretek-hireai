import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DbService } from '../../platform/database/db.service';
import { setTenantId } from '../../platform/database/tenant-context';
import { audit } from '../../platform/audit/audit';
import { readConfig } from '../../platform/config';
import { Actor } from '../../shared/actor';
import { Role } from '../../shared/enums';
import { ADMIN_ROLES } from '../../shared/role-groups';
import { CreateUserInput, LoginInput, UserStatusInput } from './auth.schemas';
import { hashPassword, verifyPassword } from './password';

@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword('unused-dummy-login-verification');
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}
  async login(input: LoginInput) {
    setTenantId(input.tenantId);
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

  me(actor: Actor) {
    return this.db.one(
      'SELECT id,tenant_id,full_name,email,role,active FROM users WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, actor.userId],
    );
  }

  async createUser(actor: Actor, input: CreateUserInput) {
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

  async setStatus(actor: Actor, id: string, input: UserStatusInput) {
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
