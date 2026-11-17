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
import { ORGANIZATION_STAFF_ROLES } from '../../shared/role-groups';
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
    let tenantId = input.tenantId;
    if (input.organizationSlug) {
      const resolved = await this.db.one<{ id: string | null }>(
        'SELECT resolve_public_tenant($1) AS id',
        [input.organizationSlug],
      );
      tenantId = resolved?.id ?? undefined;
    }
    if (!tenantId) {
      await verifyPassword(input.password, await this.dummyHash);
      throw new UnauthorizedException('Invalid credentials');
    }
    setTenantId(tenantId);
    const user = await this.db.one(
      'SELECT id,tenant_id,password_hash,active FROM users WHERE tenant_id=$1 AND lower(email)=$2',
      [tenantId, input.email],
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
      "SELECT u.id,u.tenant_id,u.full_name,u.email,u.role,u.active,t.name AS organization_name,t.slug AS organization_slug,(t.is_platform AND u.role='SUPER_ADMIN') AS platform_admin FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2",
      [actor.tenantId, actor.userId],
    );
  }

  async createUser(actor: Actor, input: CreateUserInput) {
    if (
      actor.role !== Role.HR_ADMIN ||
      !ORGANIZATION_STAFF_ROLES.some((role) => role === input.role)
    )
      throw new ForbiddenException(
        'Organization administrators can create staff only; use organization provisioning for initial administrators',
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
    if (actor.role !== Role.HR_ADMIN) throw new ForbiddenException();
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
      if (target.role === Role.SUPER_ADMIN || target.role === Role.HR_ADMIN)
        throw new ForbiddenException();
      const state = await tx.one(
        'SELECT invitation_pending,password_hash FROM users WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, id],
      );
      if (
        input.active &&
        (state?.invitation_pending ||
          state?.password_hash === '!invitation-pending')
      )
        throw new ForbiddenException(
          'Pending invitations must be accepted by the recipient',
        );
      if (!input.active)
        await tx.query(
          'UPDATE user_invitations SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL',
          [actor.tenantId, id],
        );
      const row = await tx.one(
        'UPDATE users SET active=$3,invitation_pending=false WHERE tenant_id=$1 AND id=$2 RETURNING id,email,full_name,role,active',
        [actor.tenantId, id, input.active],
      );
      await audit(tx, actor, 'user.status_changed', 'user', id, {
        active: input.active,
      });
      return row;
    });
  }
}
