import { randomBytes } from 'node:crypto';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../src/modules/super-admin/secrets';
import {
  requirePlatform,
  SuperAdminService,
  csvCell,
} from '../src/modules/super-admin/super-admin.service';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/enums';
import {
  statusSchema,
  filters,
  integrationSchema,
} from '../src/modules/super-admin/super-admin.schemas';
const actor = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: Role.SUPER_ADMIN,
};
describe('Super Admin security policy', () => {
  it('rejects non-platform accounts even when the primary role says Super Admin', async () => {
    const db = {
      one: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    await expect(requirePlatform(db, actor)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      requirePlatform(db, { ...actor, role: Role.HR_ADMIN }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.one).toHaveBeenCalledTimes(1);
  });
  it('encrypts with unique nonces, authenticates scope, and only masks the last four characters', () => {
    const original = process.env.INTEGRATION_ENCRYPTION_KEY;
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    try {
      const secret = 'secret-credential-1234',
        encrypted = encryptSecret(secret, 'scope');
      expect(encrypted).not.toContain(secret);
      expect(encryptSecret(secret, 'scope')).not.toBe(encrypted);
      expect(decryptSecret(encrypted, 'scope')).toBe(secret);
      expect(() => decryptSecret(encrypted, 'other')).toThrow();
      expect(maskSecret(secret).endsWith('1234')).toBe(true);
      expect(maskSecret(secret)).not.toContain('credential');
    } finally {
      if (original === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = original;
    }
  });
  it('requires a suspension reason, bounded paging, and rejects arbitrary provider URLs', () => {
    expect(statusSchema.safeParse({ status: 'suspended' }).success).toBe(false);
    expect(filters.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      integrationSchema.safeParse({
        provider: 'http://localhost',
        credential: '12345678',
        environment: 'sandbox',
      }).success,
    ).toBe(false);
  });
  it('serializes and protects the last active Super Admin', async () => {
    const tx = {
      one: jest
        .fn()
        .mockResolvedValueOnce({ id: actor.userId, active: true })
        .mockResolvedValueOnce({ count: 1 }),
      query: jest.fn(),
    };
    const db = {
      one: jest.fn().mockResolvedValue({ id: actor.userId }),
      transaction: jest.fn((fn) => fn(tx)),
    };
    const service = new SuperAdminService(db as unknown as DbService);
    await expect(
      service.adminStatus(actor, actor.userId, false),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.query).toHaveBeenCalledWith(
      'SELECT id FROM tenants WHERE id=$1 FOR UPDATE',
      [actor.tenantId],
    );
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
  it('prevents spreadsheet formula execution in CSV exports', () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(csvCell('normal, "quoted"')).toBe('"normal, ""quoted"""');
  });
  it('warns on actual usage and active trials without zero-quota false alarms', async () => {
    const service = new SuperAdminService({
      query: jest.fn(async () => []),
    } as unknown as DbService);
    const base = {
      status: 'active',
      created_at: new Date(0),
      limits: { max_users: 100, storage_mb: 0, call_minutes_per_month: 100 },
      usage: { users: 1, storage_mb: 0, call_minutes: 0 },
    };
    jest.spyOn(service, 'reports').mockResolvedValue({
      organizations: [
        { ...base, id: 'normal', trial_ends_at: new Date(0) },
        { ...base, id: 'calls', usage: { ...base.usage, call_minutes: 95 } },
        { ...base, id: 'trial', status: 'trial', trial_ends_at: new Date() },
      ],
      integrations: [],
    });
    jest.spyOn(service, 'logs').mockResolvedValue({
      data: [],
      pagination: { limit: 10, offset: 0, total: 0 },
    });
    expect((await service.dashboard(actor)).attention.map((r) => r.id)).toEqual(
      ['calls', 'trial'],
    );
  });
});
