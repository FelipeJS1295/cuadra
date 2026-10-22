import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { BASE_DB, type Database } from '../database/database.module.js';
import { memberships, tenants, users, type UserRole } from '../database/schema/index.js';
import { authSecret, SESSION_COOKIE, TENANT_COOKIE } from './auth.config.js';
import { passwordFingerprint, verifySession } from './crypto.js';
import { IS_PUBLIC, NO_TENANT, ROLES, SUPERADMIN, type SessionUser } from './decorators.js';

/** Lee una cookie del header (sin dependencias extra) */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Guardia global:
 *  - Todas las rutas exigen sesión, salvo @Public().
 *  - Fija la empresa del pedido: la de la cookie (si el usuario pertenece a ella) o su primera
 *    empresa. Sin empresa solo puede usar rutas @NoTenant.
 *  - @Roles(...) limita por rol dentro de la empresa (DUENO siempre puede). Sin @Roles:
 *    cualquier rol LEE (GET); para modificar se necesita DUENO, ADMIN u OPERADOR.
 *  - @Superadmin() solo para el administrador del sistema.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(BASE_DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? verifySession(token, authSecret()) : null;
    if (!session) throw new UnauthorizedException('Inicia sesión para continuar');

    // Se lee el usuario en cada pedido: si lo desactivan o cambian su rol, aplica de inmediato
    const [user] = await this.db.select().from(users).where(eq(users.id, session.sub));
    if (!user || !user.isActive || passwordFingerprint(user.passwordHash) !== session.pf) {
      throw new UnauthorizedException('Tu sesión ya no es válida. Inicia sesión de nuevo');
    }

    // Empresas del usuario (activas)
    const mine = await this.db
      .select({ tenantId: memberships.tenantId, role: memberships.role, name: tenants.name, status: tenants.status })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, user.id), eq(memberships.isActive, true)))
      .orderBy(asc(memberships.createdAt));
    const wanted = readCookie(req, TENANT_COOKIE);
    let current = mine.find((m) => m.tenantId === wanted) ?? mine[0] ?? null;
    // El superadmin puede entrar a cualquier empresa (para dar soporte) como DUENO
    if (!mine.some((m) => m.tenantId === wanted) && wanted && user.isSuperadmin) {
      const [t] = await this.db.select().from(tenants).where(eq(tenants.id, wanted));
      if (t) current = { tenantId: t.id, role: 'DUENO', name: t.name, status: t.status };
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperadmin: user.isSuperadmin,
      mustChangePassword: user.mustChangePassword,
      tenantId: current?.tenantId ?? null,
      tenantName: current?.name ?? null,
      role: (current?.role ?? 'LECTURA') as UserRole,
    };

    if (this.reflector.getAllAndOverride<boolean>(SUPERADMIN, targets)) {
      if (!user.isSuperadmin) throw new ForbiddenException('Solo para el administrador del sistema');
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) return true;

    if (!current) throw new ForbiddenException('Aún no tienes una empresa. Crea una para empezar');
    if (current.status === 'SUSPENDIDA' && !user.isSuperadmin) {
      throw new ForbiddenException('La cuenta de esta empresa está suspendida. Contáctanos para reactivarla');
    }

    const role = current.role as UserRole;
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && role !== 'DUENO' && !roles.includes(role)) {
      throw new ForbiddenException('No tienes permiso para esta acción');
    }
    if (!roles && req.method !== 'GET' && role === 'LECTURA') {
      throw new ForbiddenException('Tu usuario es de solo lectura');
    }
    return true;
  }
}
