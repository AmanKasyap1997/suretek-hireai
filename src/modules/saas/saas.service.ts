import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbService, DbClient } from '../../platform/database/db.service';
import {
  runWithTenant,
  setTenantId,
} from '../../platform/database/tenant-context';
import { audit } from '../../platform/audit/audit';
import { readConfig } from '../../platform/config';
import { Actor, Role } from '../../shared/actor';
import { EmailPort, InvitationEmail } from '../../integrations';
import { hashPassword } from '../auth';
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  InviteStaffInput,
  ListInput,
  ORGANIZATION_STAFF_ROLES,
} from './saas.schemas';
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
function secret() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: digest(token),
    expiresAt: new Date(
      Date.now() + readConfig().INVITATION_TTL_SECONDS * 1000,
    ),
  };
}
function conflict(error: unknown): never {
  if ((error as { code?: string }).code === '23505')
    throw new ConflictException('Organization or account already exists');
  throw error;
}
@Injectable()
export class SaasService {
  constructor(
    private readonly db: DbService,
    private readonly email: EmailPort,
  ) {}

  private async platform(actor: Actor) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException();
    const row = await this.db.one(
      'SELECT u.id FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2 AND u.active AND u.role=$3 AND t.is_platform',
      [actor.tenantId, actor.userId, Role.SUPER_ADMIN],
    );
    if (!row)
      throw new ForbiddenException(
        'Platform account is not provisioned. Run the platform bootstrap as an operator.',
      );
  }
  private async organization(actor: Actor) {
    if (actor.role !== Role.HR_ADMIN) throw new ForbiddenException();
    const row = await this.db.one<{ name: string; slug: string }>(
      'SELECT name,slug FROM tenants WHERE id=$1 AND NOT is_platform',
      [actor.tenantId],
    );
    if (!row) throw new ForbiddenException();
    return row;
  }
  async organizations(actor: Actor, page: ListInput) {
    await this.platform(actor);
    const data = await this.db.query(
      'SELECT organization_id AS id,name,slug,admin_name,admin_email,delivery_status,created_at FROM platform_organizations WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
      [actor.tenantId, page.limit, page.offset],
    );
    const count = await this.db.one(
      'SELECT count(*)::int AS total FROM platform_organizations WHERE tenant_id=$1',
      [actor.tenantId],
    );
    return { data, pagination: { ...page, total: count!.total } };
  }
  async createOrganization(actor: Actor, input: CreateOrganizationInput) {
    await this.platform(actor);
    const invitation = secret();
    let result: {
      organization_id: string;
      admin_id: string;
      invitation_id: string;
    };
    try {
      result = (await this.db.one(
        'SELECT * FROM provision_organization($1,$2,$3,$4,$5,$6,$7)',
        [
          actor.userId,
          input.name,
          input.slug,
          input.adminName,
          input.adminEmail,
          invitation.hash,
          invitation.expiresAt,
        ],
      ))!;
    } catch (error) {
      return conflict(error);
    }
    const deliveryStatus = await this.deliver(
      result.organization_id,
      result.invitation_id,
      {
        to: input.adminEmail,
        fullName: input.adminName,
        organizationName: input.name,
        organizationSlug: input.slug,
        role: Role.HR_ADMIN,
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      },
    );
    await this.db.query(
      'UPDATE platform_organizations SET delivery_status=$3 WHERE tenant_id=$1 AND organization_id=$2 AND last_invitation_id=$4',
      [
        actor.tenantId,
        result.organization_id,
        deliveryStatus,
        result.invitation_id,
      ],
    );
    return {
      id: result.organization_id,
      name: input.name,
      slug: input.slug,
      deliveryStatus,
    };
  }
  async resendOrganizationAdmin(actor: Actor, organizationId: string) {
    await this.platform(actor);
    const { row, invite } = await this.db.transaction(async (tx) => {
      const row = await tx.one<{
        organization_id: string;
        admin_user_id: string;
        name: string;
        slug: string;
      }>(
        'SELECT organization_id,admin_user_id,name,slug FROM platform_organizations WHERE tenant_id=$1 AND organization_id=$2 FOR UPDATE',
        [actor.tenantId, organizationId],
      );
      if (!row) throw new NotFoundException();
      // Switch only this transaction's RLS scope, then restore the platform
      // scope before updating its directory. Token rotation and metadata commit together.
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
        row.organization_id,
      ]);
      const invite = await this.rotateInTransaction(
        tx,
        row.organization_id,
        row.admin_user_id,
        null,
      );
      await tx.query("SELECT set_config('app.tenant_id',$1,true)", [
        actor.tenantId,
      ]);
      await tx.query(
        'UPDATE platform_organizations SET last_invitation_id=$3,delivery_status=$4 WHERE tenant_id=$1 AND organization_id=$2',
        [actor.tenantId, organizationId, invite.id, 'PENDING'],
      );
      await audit(
        tx,
        actor,
        'organization.admin_invitation_resent',
        'organization',
        organizationId,
      );
      return { row, invite };
    });
    const deliveryStatus = await this.deliver(row.organization_id, invite.id, {
      to: invite.user.email,
      fullName: invite.user.full_name,
      organizationName: row.name,
      organizationSlug: row.slug,
      role: Role.HR_ADMIN,
      token: invite.token,
      expiresAt: invite.expiresAt,
    });
    await this.db.query(
      'UPDATE platform_organizations SET delivery_status=$3 WHERE tenant_id=$1 AND organization_id=$2 AND last_invitation_id=$4',
      [actor.tenantId, organizationId, deliveryStatus, invite.id],
    );
    return { deliveryStatus };
  }
  async users(actor: Actor, page: ListInput) {
    await this.organization(actor);
    const data = await this.db.query(
      `SELECT u.id,u.full_name,u.email,u.role,u.active,u.invitation_pending,(u.password_hash LIKE 'scrypt:%') AS password_set,
      i.expires_at AS invitation_expires_at,i.delivery_status
      FROM users u LEFT JOIN LATERAL (SELECT expires_at,delivery_status FROM user_invitations WHERE tenant_id=u.tenant_id AND user_id=u.id AND revoked_at IS NULL AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1) i ON true
      WHERE u.tenant_id=$1 AND u.role<>$2 ORDER BY u.created_at DESC,u.id LIMIT $3 OFFSET $4`,
      [actor.tenantId, Role.SUPER_ADMIN, page.limit, page.offset],
    );
    const count = await this.db.one(
      'SELECT count(*)::int AS total FROM users WHERE tenant_id=$1 AND role<>$2',
      [actor.tenantId, Role.SUPER_ADMIN],
    );
    return { data, pagination: { ...page, total: count!.total } };
  }
  async inviteStaff(actor: Actor, input: InviteStaffInput) {
    const organization = await this.organization(actor);
    if (!ORGANIZATION_STAFF_ROLES.includes(input.role))
      throw new ForbiddenException();
    const invitation = secret();
    let result: { userId: string; id: string };
    try {
      result = await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
          actor.tenantId,
        ]);
        const user = await tx.one(
          'INSERT INTO users(tenant_id,email,password_hash,full_name,role,active,invitation_pending) VALUES($1,$2,$3,$4,$5,false,true) RETURNING id',
          [
            actor.tenantId,
            input.email,
            '!invitation-pending',
            input.fullName,
            input.role,
          ],
        );
        const row = await tx.one(
          'INSERT INTO user_invitations(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING id',
          [actor.tenantId, user!.id, invitation.hash, invitation.expiresAt],
        );
        await audit(tx, actor, 'user.invited', 'user', user!.id, {
          role: input.role,
        });
        return { userId: user!.id, id: row!.id };
      });
    } catch (error) {
      return conflict(error);
    }
    const deliveryStatus = await this.deliver(actor.tenantId, result.id, {
      to: input.email,
      fullName: input.fullName,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      role: input.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    });
    return { id: result.userId, deliveryStatus };
  }
  async resendStaff(actor: Actor, userId: string) {
    const organization = await this.organization(actor);
    const user = await this.db.one(
      'SELECT role FROM users WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, userId],
    );
    if (!user) throw new NotFoundException();
    if (!ORGANIZATION_STAFF_ROLES.includes(user.role))
      throw new ForbiddenException();
    const invitation = await this.rotate(actor.tenantId, userId, actor.userId);
    const deliveryStatus = await this.deliver(actor.tenantId, invitation.id, {
      to: invitation.user.email,
      fullName: invitation.user.full_name,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      role: invitation.user.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    });
    return { deliveryStatus };
  }
  private async rotate(
    tenantId: string,
    userId: string,
    actorId: string | null,
  ) {
    return runWithTenant(tenantId, () =>
      this.db.transaction((tx) =>
        this.rotateInTransaction(tx, tenantId, userId, actorId),
      ),
    );
  }
  private async rotateInTransaction(
    tx: DbClient,
    tenantId: string,
    userId: string,
    actorId: string | null,
  ) {
    const invitation = secret();
    const user = await tx.one(
      'SELECT id,email,full_name,role,invitation_pending,active,password_hash FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, userId],
    );
    if (!user) throw new NotFoundException();
    if (
      user.active ||
      (!user.invitation_pending && user.password_hash !== '!invitation-pending')
    )
      throw new ConflictException(
        'Account already accepted or invitation cancelled',
      );
    await tx.query(
      'UPDATE users SET invitation_pending=true WHERE tenant_id=$1 AND id=$2',
      [tenantId, userId],
    );
    await tx.query(
      'UPDATE user_invitations SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL',
      [tenantId, userId],
    );
    const row = await tx.one(
      'INSERT INTO user_invitations(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING id',
      [tenantId, userId, invitation.hash, invitation.expiresAt],
    );
    await audit(
      tx,
      { tenantId, userId: actorId },
      'user.invitation_resent',
      'user',
      userId,
    );
    return { ...invitation, id: row!.id, user };
  }
  private async deliver(
    tenantId: string,
    invitationId: string,
    message: InvitationEmail,
  ) {
    let delivered = false;
    try {
      delivered = await this.email.sendInvitation(message);
    } catch {
      /* Never expose SMTP errors or invitation secrets. */
    }
    const status = delivered ? 'SENT' : 'FAILED';
    await runWithTenant(tenantId, () =>
      this.db.query(
        'UPDATE user_invitations SET delivery_status=$3 WHERE tenant_id=$1 AND id=$2',
        [tenantId, invitationId, status],
      ),
    );
    return status;
  }
  async accept(input: AcceptInvitationInput) {
    const resolved = await this.db.one<{ id: string | null }>(
      'SELECT resolve_public_tenant($1) AS id',
      [input.organizationSlug],
    );
    if (!resolved?.id)
      throw new BadRequestException('Invitation is invalid or expired');
    const tenantId = resolved.id;
    setTenantId(tenantId);
    const hash = await hashPassword(input.password);
    await this.db.transaction(async (tx) => {
      const candidate = await tx.one(
        'SELECT id,user_id FROM user_invitations WHERE tenant_id=$1 AND token_hash=$2',
        [tenantId, digest(input.token)],
      );
      if (!candidate)
        throw new BadRequestException('Invitation is invalid or expired');
      const user = await tx.one(
        'SELECT invitation_pending,active,role FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, candidate.user_id],
      );
      const invitation = await tx.one(
        'SELECT accepted_at,revoked_at,expires_at FROM user_invitations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, candidate.id],
      );
      if (
        !user?.invitation_pending ||
        user.active ||
        !invitation ||
        invitation.accepted_at ||
        invitation.revoked_at ||
        new Date(invitation.expires_at).getTime() <= Date.now() ||
        user.role === Role.SUPER_ADMIN
      )
        throw new BadRequestException('Invitation is invalid or expired');
      await tx.query(
        'UPDATE users SET password_hash=$3,active=true,invitation_pending=false WHERE tenant_id=$1 AND id=$2',
        [tenantId, candidate.user_id, hash],
      );
      await tx.query(
        'UPDATE user_invitations SET accepted_at=now() WHERE tenant_id=$1 AND id=$2',
        [tenantId, candidate.id],
      );
      await audit(
        tx,
        { tenantId, userId: candidate.user_id },
        'user.invitation_accepted',
        'user',
        candidate.user_id,
      );
    });
    return { organizationSlug: input.organizationSlug };
  }
}
