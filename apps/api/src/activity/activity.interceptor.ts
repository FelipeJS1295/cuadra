import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import type { SessionUser } from '../auth/decorators.js';
import { ActivityService } from './activity.service.js';
import { describeAction, IGNORED } from './describe.js';

/**
 * Anota cada acción (POST, PUT, PATCH, DELETE) de un usuario con sesión: qué hizo, en qué
 * empresa y si resultó o falló. Las consultas (GET) no se anotan; las páginas las avisa la web.
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const key = `${req.method} ${route}`;
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD' || IGNORED.has(key)) return next.handle();

    const save = (status: number) => {
      const user = req.user;
      if (!user) return;
      this.activity.record({
        kind: 'ACCION',
        description: describeAction(req.method, route, req.params as Record<string, string>),
        userId: user.id,
        companyId: user.tenantId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status,
        req,
      });
    };
    return next.handle().pipe(
      tap({
        next: () => save(context.switchToHttp().getResponse<Response>().statusCode),
        error: (err: { status?: number; getStatus?: () => number }) => save(err?.getStatus?.() ?? err?.status ?? 500),
      }),
    );
  }
}
