import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { cookieSecure, sessionDays, TENANT_COOKIE } from '../auth/auth.config.js';
import { Superadmin } from '../auth/decorators.js';
import { BASE_DB, type Database } from '../database/database.module.js';
import { tenants } from '../database/schema/index.js';
import { validate } from '../products/catalog.validation.js';

/**
 * Panel del administrador del sistema (todas las empresas).
 *   GET   /api/admin/tenants
 *   PATCH /api/admin/tenants/:id        { plan?, status?, trialEndsAt? }
 *   POST  /api/admin/tenants/:id/enter  entrar a la empresa para dar soporte
 */
@Superadmin()
@Controller('admin')
export class AdminController {
  constructor(@Inject(BASE_DB) private readonly db: Database) {}

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
        trialEndsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
}
