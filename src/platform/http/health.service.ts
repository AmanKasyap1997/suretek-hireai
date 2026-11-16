import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from '../database/db.service';

@Injectable()
export class HealthService {
  constructor(private readonly db: DbService) {}

  live() {
    return { status: 'ok' };
  }

  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
