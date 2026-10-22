import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { BASE_DB, type Database } from '../database/database.module.js';
import { withTenant } from '../database/tenant-context.js';
import type { SessionUser } from './decorators.js';

/**
 * Si el pedido es de una empresa, lo ejecuta completo dentro de la transacción de esa
 * empresa (RLS activo). Si algo falla, no queda nada a medias.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(@Inject(BASE_DB) private readonly db: Database) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) return next.handle();
    return from(withTenant(this.db, tenantId, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }
}
