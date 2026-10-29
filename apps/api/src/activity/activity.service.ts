import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { BASE_DB, type Database } from '../database/database.module.js';
import { userActivity } from '../database/schema/index.js';

export type ActivityKind = 'LOGIN' | 'LOGIN_FALLIDO' | 'PAGINA' | 'ACCION';

/** Se guarda la actividad de los últimos 365 días */
const KEEP_DAYS = 365;

/** IP real del usuario (detrás de Nginx viene en X-Forwarded-For) */
export function clientIp(req: Request) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  return (fwd || req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 60) || null;
}

/** Anota la actividad de los usuarios sin frenar los pedidos (si falla, solo queda en el log) */
@Injectable()
export class ActivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(BASE_DB) private readonly db: Database) {}

  record(e: {
    kind: ActivityKind;
    description: string;
    userId?: string | null;
    companyId?: string | null;
    method?: string | null;
    path?: string | null;
    status?: number | null;
    req?: Request;
    detail?: unknown;
  }) {
    this.db
      .insert(userActivity)
      .values({
        kind: e.kind,
        description: e.description.slice(0, 500),
        userId: e.userId ?? null,
        companyId: e.companyId ?? null,
        method: e.method ?? null,
        path: e.path?.slice(0, 300) ?? null,
        status: e.status ?? null,
        ip: e.req ? clientIp(e.req) : null,
        userAgent: e.req ? String(e.req.headers['user-agent'] ?? '').slice(0, 300) || null : null,
        detail: (e.detail ?? null) as never,
      })
      .catch((err) => this.logger.warn(`No se pudo anotar la actividad: ${(err as Error).message}`));
  }

  onModuleInit() {
    // Limpieza diaria de lo más antiguo
    const purge = () => this.db.execute(sql`delete from user_activity where created_at < now() - make_interval(days => ${KEEP_DAYS})`).catch(() => undefined);
    void purge();
    this.timer = setInterval(purge, 24 * 3600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
