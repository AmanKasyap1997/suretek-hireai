import {
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DbService } from '../database/db.service';
import { Roles, Public } from '../auth/roles.decorator';
import { Actor, CurrentUser } from './actor';
import { parse, paginationSchema } from './validation';
@ApiTags('Health')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly db: DbService) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    try {
      await this.db.query('SELECT 1 FROM users LIMIT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
@ApiTags('Reporting and audit')
@ApiBearerAuth()
@Controller()
export class PlatformController {
  constructor(private readonly db: DbService) {}
  @Get('reports/hiring-summary')
  @Roles('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER')
  async summary(@CurrentUser() actor: Actor) {
    return {
      applicationsByStage: await this.db.query(
        'SELECT stage,count(*)::int AS count FROM applications WHERE tenant_id=$1 GROUP BY stage ORDER BY stage',
        [actor.tenantId],
      ),
      jobsByStatus: await this.db.query(
        'SELECT status,count(*)::int AS count FROM jobs WHERE tenant_id=$1 GROUP BY status ORDER BY status',
        [actor.tenantId],
      ),
    };
  }
  @Get('audit-events')
  @Roles('SUPER_ADMIN', 'HR_ADMIN')
  async audit(@CurrentUser() actor: Actor, @Query() query: unknown) {
    const p = parse(paginationSchema, query);
    return {
      data: await this.db.query(
        'SELECT id,actor_id,action,entity_type,entity_id,metadata,created_at FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [actor.tenantId, p.limit, p.offset],
      ),
      pagination: p,
    };
  }
}
