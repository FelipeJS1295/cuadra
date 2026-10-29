import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { cookieSecure, sessionDays, TENANT_COOKIE } from '../auth/auth.config.js';
import { Superadmin } from '../auth/decorators.js';
import { BASE_DB, type Database } from '../database/database.module.js';
import { tenants, users } from '../database/schema/index.js';
import { hashPassword } from '../auth/crypto.js';
import { ActivityService } from '../activity/activity.service.js';
import { CurrentUser, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';

/**
 * Panel del administrador del sistema (todas las empresas).
 *   GET   /api/admin/tenants
 *   PATCH /api/admin/tenants/:id        { plan?, status?, trialEndsAt? }
 *   POST  /api/admin/tenants/:id/enter  entrar a la empresa para dar soporte
 *   GET   /api/admin/users?tenantId=      usuarios con sus empresas y cuánto usan Cuadra
 *   GET   /api/admin/activity?tenantId=&userId=&kind=&days=&before=   actividad (lo más nuevo primero)
 *   GET   /api/admin/activity/summary?tenantId=&userId=&days=         páginas y acciones más usadas, ingresos por día
 *   POST  /api/admin/users/:id/password  { password, mustChange }      cambia la clave de un usuario
 */
@Superadmin()
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(BASE_DB) private readonly db: Database,
    private readonly activity: ActivityService,
  ) {}

  @Get('tenants')
  async list() {
    // Corre como dueño de las tablas: ve todas las empresas (sin RLS)
    const { rows } = await this.db.execute<{
      id: string;
      name: string;
      tax_id: string | null;
      plan: string;
      status: string;
      trial_ends_at: string | null;
      created_at: string;
      users: number;
      orders: number;
      last_order: string | null;
      receipts: number;
      owner: string | null;
    }>(sql`
      select t.id, t.name, t.tax_id, t.plan, t.status, t.trial_ends_at::text, t.created_at::text,
        (select count(*) from memberships m where m.tenant_id = t.id)::int as users,
        (select count(distinct (s.retailer_id, s.order_number)) from sales_records s where s.tenant_id = t.id)::int as orders,
        (select max(s.order_date)::date::text from sales_records s where s.tenant_id = t.id) as last_order,
        (select count(*) from customer_receipts c where c.tenant_id = t.id)::int as receipts,
        (select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'DUENO' order by m.created_at limit 1) as owner
      from tenants t order by t.created_at desc
    `);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      taxId: r.tax_id,
      plan: r.plan,
      status: r.status,
      trialEndsAt: r.trial_ends_at,
      createdAt: r.created_at,
      users: r.users,
      orders: r.orders,
      lastOrder: r.last_order,
      receipts: r.receipts,
      owner: r.owner,
    }));
  }

  @Patch('tenants/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(
      z.object({
        plan: z.enum(['PRUEBA', 'BASICO', 'PRO']).optional(),
        status: z.enum(['ACTIVA', 'SUSPENDIDA']).optional(),
        trialEndsAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      }),
      body,
    );
    await this.db.update(tenants).set(data).where(eq(tenants.id, id));
    return { ok: true };
  }

  @Post('tenants/:id/enter')
  @HttpCode(200)
  enter(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    res.cookie(TENANT_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: cookieSecure(), path: '/', maxAge: sessionDays() * 86400 * 1000 });
    return { ok: true };
  }

  // ------------------------------------------------------------------ Usuarios y actividad

  @Get('users')
  async users(@Query('tenantId') tenantId?: string) {
    const t = tenantId ? validate(z.string().uuid('Empresa inválida'), tenantId) : null;
    const { rows } = await this.db.execute<{
      id: string;
      email: string;
      name: string;
      is_active: boolean;
      is_superadmin: boolean;
      must_change_password: boolean;
      created_at: string | Date;
      last_login_at: string | Date | null;
      companies: { id: string; name: string; role: string; active: boolean }[] | null;
      logins_30: number;
      logins_total: number;
      failed_30: number;
      actions_30: number;
      pages_30: number;
      days_30: number;
      last_seen: string | Date | null;
    }>(sql`
      select u.id, u.email, u.name, u.is_active, u.is_superadmin, u.must_change_password,
        u.created_at, u.last_login_at,
        (select json_agg(json_build_object('id', t.id, 'name', t.name, 'role', m.role, 'active', m.is_active) order by t.name)
           from memberships m join tenants t on t.id = m.tenant_id where m.user_id = u.id) as companies,
        (select count(*) from user_activity a where a.user_id = u.id and a.kind = 'LOGIN' and a.created_at > now() - interval '30 days')::int as logins_30,
        (select count(*) from user_activity a where a.user_id = u.id and a.kind = 'LOGIN')::int as logins_total,
        (select count(*) from user_activity a where a.user_id = u.id and a.kind = 'LOGIN_FALLIDO' and a.created_at > now() - interval '30 days')::int as failed_30,
        (select count(*) from user_activity a where a.user_id = u.id and a.kind = 'ACCION' and a.created_at > now() - interval '30 days'
           ${t ? sql`and a.company_id = ${t}` : sql``})::int as actions_30,
        (select count(*) from user_activity a where a.user_id = u.id and a.kind = 'PAGINA' and a.created_at > now() - interval '30 days'
           ${t ? sql`and a.company_id = ${t}` : sql``})::int as pages_30,
        (select count(distinct (a.created_at at time zone 'America/Santiago')::date) from user_activity a
           where a.user_id = u.id and a.kind <> 'LOGIN_FALLIDO' and a.created_at > now() - interval '30 days')::int as days_30,
        (select max(a.created_at) from user_activity a where a.user_id = u.id and a.kind <> 'LOGIN_FALLIDO') as last_seen
      from users u
      ${t ? sql`where exists (select 1 from memberships m where m.user_id = u.id and m.tenant_id = ${t})` : sql``}
      order by coalesce((select max(a.created_at) from user_activity a where a.user_id = u.id), u.last_login_at, u.created_at) desc nulls last
    `);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isActive: r.is_active,
      isSuperadmin: r.is_superadmin,
      mustChangePassword: r.must_change_password,
      createdAt: iso(r.created_at),
      lastLoginAt: iso(r.last_login_at),
      lastSeen: iso(r.last_seen),
      companies: r.companies ?? [],
      logins30: r.logins_30,
      loginsTotal: r.logins_total,
      failed30: r.failed_30,
      actions30: r.actions_30,
      pages30: r.pages_30,
      days30: r.days_30,
    }));
  }

  private filters(q: { tenantId?: string; userId?: string; kind?: string; days?: string }) {
    const f = validate(
      z.object({
        tenantId: z.string().uuid().optional(),
        userId: z.string().uuid().optional(),
        kind: z.enum(['LOGIN', 'LOGIN_FALLIDO', 'PAGINA', 'ACCION']).optional(),
        days: z.coerce.number().int().min(1).max(365).default(30),
      }),
      Object.fromEntries(Object.entries(q).filter(([, v]) => v)),
    );
    return {
      ...f,
      where: sql`a.created_at > now() - make_interval(days => ${f.days})
        ${f.tenantId ? sql`and a.company_id = ${f.tenantId}` : sql``}
        ${f.userId ? sql`and a.user_id = ${f.userId}` : sql``}`,
    };
  }

  @Get('activity')
  async activityList(
    @Query('tenantId') tenantId?: string,
    @Query('userId') userId?: string,
    @Query('kind') kind?: string,
    @Query('days') days?: string,
    @Query('before') before?: string,
  ) {
    const f = this.filters({ tenantId, userId, kind, days });
    const until = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
    const { rows } = await this.db.execute<{
      id: string;
      kind: string;
      description: string;
      path: string | null;
      status: number | null;
      ip: string | null;
      user_agent: string | null;
      created_at: string | Date;
      user_id: string | null;
      user_name: string | null;
      user_email: string | null;
      company_id: string | null;
      company: string | null;
      detail: { email?: string } | null;
    }>(sql`
      select a.id, a.kind, a.description, a.path, a.status, a.ip, a.user_agent, a.created_at, a.detail,
        a.user_id, u.name as user_name, u.email as user_email, a.company_id, t.name as company
      from user_activity a
      left join users u on u.id = a.user_id
      left join tenants t on t.id = a.company_id
      where ${f.where}
        ${f.kind ? sql`and a.kind = ${f.kind}` : sql``}
        ${until ? sql`and a.created_at < ${until.toISOString()}` : sql``}
      order by a.created_at desc
      limit 200
    `);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      description: r.description,
      path: r.path,
      status: r.status,
      ip: r.ip,
      device: device(r.user_agent),
      at: iso(r.created_at)!,
      user: r.user_id ? { id: r.user_id, name: r.user_name, email: r.user_email } : r.detail?.email ? { id: null, name: null, email: r.detail.email } : null,
      company: r.company_id ? { id: r.company_id, name: r.company } : null,
    }));
  }

  @Get('activity/summary')
  async activitySummary(@Query('tenantId') tenantId?: string, @Query('userId') userId?: string, @Query('days') days?: string) {
    const f = this.filters({ tenantId, userId, days });
    const [pages, actions, byDay] = await Promise.all([
      this.db.execute<{ name: string; n: number }>(sql`
        select a.description as name, count(*)::int as n from user_activity a
        where ${f.where} and a.kind = 'PAGINA' group by 1 order by 2 desc limit 12`),
      this.db.execute<{ name: string; n: number; failed: number }>(sql`
        select a.description as name, count(*)::int as n, count(*) filter (where a.status >= 400)::int as failed from user_activity a
        where ${f.where} and a.kind = 'ACCION' group by 1 order by 2 desc limit 15`),
      this.db.execute<{ day: string; logins: number; actions: number; pages: number }>(sql`
        select (a.created_at at time zone 'America/Santiago')::date::text as day,
          count(*) filter (where a.kind = 'LOGIN')::int as logins,
          count(*) filter (where a.kind = 'ACCION')::int as actions,
          count(*) filter (where a.kind = 'PAGINA')::int as pages
        from user_activity a where ${f.where} group by 1 order by 1`),
    ]);
    return { days: f.days, pages: pages.rows, actions: actions.rows, byDay: byDay.rows };
  }

  @Post('users/:id/password')
  @HttpCode(200)
  async setPassword(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() admin: SessionUser, @Req() req: Request) {
    const { password, mustChange } = validate(
      z.object({
        password: z.string().min(8, 'La clave debe tener al menos 8 caracteres').max(100),
        mustChange: z.boolean().default(true),
      }),
      body,
    );
    const [u] = await this.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id));
    if (!u) throw new NotFoundException('El usuario no existe');
    if (u.id === admin.id && mustChange) throw new BadRequestException('Para tu propia clave no marques "pedir cambio al entrar"');
    // Cambiar la clave cierra las sesiones abiertas de ese usuario (la sesión lleva la huella de la clave)
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: mustChange, isActive: true })
      .where(eq(users.id, id));
    this.activity.record({
      kind: 'ACCION',
      description: `Admin: cambió la clave de ${u.email}`,
      userId: admin.id,
      method: 'POST',
      path: `/api/admin/users/${id}/password`,
      status: 200,
      req,
    });
    return { ok: true };
  }
}

/** Fecha de Postgres en formato ISO (para el navegador) */
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

/** "Chrome · Windows" a partir del navegador */
function device(ua: string | null) {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return [br, os].filter(Boolean).join(' · ') || null;
}
