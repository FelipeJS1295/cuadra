import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '../database/schema/index.js';

export const IS_PUBLIC = 'isPublic';
export const NO_TENANT = 'noTenant';
export const SUPERADMIN = 'superadmin';
export const ROLES = 'roles';

/** Ruta sin inicio de sesión (ej: login, registro, health) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Ruta con sesión pero que no trabaja dentro de una empresa (ej: mis empresas, crear empresa) */
export const NoTenant = () => SetMetadata(NO_TENANT, true);

/** Solo para el administrador del sistema (todas las empresas) */
export const Superadmin = () => SetMetadata(SUPERADMIN, true);

/** Solo estos roles (dentro de la empresa) pueden usar la ruta. DUENO siempre puede */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

/** Usuario con sesión iniciada y la empresa en la que está trabajando */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  mustChangePassword: boolean;
  /** Empresa actual (null en rutas @NoTenant o si aún no tiene empresas) */
  tenantId: string | null;
  tenantName: string | null;
  /** Tipo de negocio de la empresa actual: REVENDEDOR · FABRICANTE */
  businessMode: 'REVENDEDOR' | 'FABRICANTE';
  /** Rol en la empresa actual */
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => ctx.switchToHttp().getRequest().user,
);
