import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@cuadra/shared';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { Public } from '../auth/decorators.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** GET /api/health — estado de la API y de la conexión a Postgres */
  @Get()
  async check(): Promise<HealthResponse> {
    const api = {
      version: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
    };

    try {
      const result = await this.db.execute<{ now: Date; version: string }>(
        sql`select now() as now, version() as version`,
      );
      const row = result.rows[0];
      return {
        status: 'ok',
        api,
        database: {
          connected: true,
          serverTime: new Date(row.now).toISOString(),
          version: row.version.split(' ').slice(0, 2).join(' '),
          error: null,
        },
      };
    } catch (err) {
      return {
        status: 'degraded',
        api,
        database: {
          connected: false,
          serverTime: null,
          version: null,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
