import 'reflect-metadata';
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/platform/database/db.service';
import { runWithTenant } from '../src/platform/database/tenant-context';
import { Actor, Role } from '../src/shared/actor';
import { ADMIN_ROLES } from '../src/shared/role-groups';
import { PrivacyService } from '../src/modules/talent-acquisition';
async function main() {
  const { values } = parseArgs({
    options: {
      'tenant-id': { type: 'string' },
      'actor-id': { type: 'string' },
      limit: { type: 'string', default: '100' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const tenantId = z.string().uuid().parse(values['tenant-id']),
    userId = z.string().uuid().parse(values['actor-id']);
  const limit = z.coerce.number().int().min(1).max(1000).parse(values.limit);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const runtime = await app
      .get(DbService)
      .one<{ name: string }>('SELECT current_user AS name');
    if (runtime?.name !== 'hireai_app')
      throw new Error('Retention requires the hireai_app runtime connection');
    await runWithTenant(tenantId, async () => {
      const user = await app
        .get(DbService)
        .one<{ role: Role }>(
          'SELECT role FROM users WHERE tenant_id=$1 AND id=$2 AND active=true',
          [tenantId, userId],
        );
      if (!user || !ADMIN_ROLES.includes(user.role))
        throw new Error(
          'Retention requires an active administrator in the selected tenant',
        );
      const actor: Actor = { tenantId, userId, role: user.role };
      console.log(
        JSON.stringify(
          await app.get(PrivacyService).retain(actor, limit, values['dry-run']),
        ),
      );
    });
  } finally {
    await app.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Retention failed');
  process.exitCode = 1;
});
