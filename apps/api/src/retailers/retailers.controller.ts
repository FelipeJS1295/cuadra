import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Roles } from '../auth/decorators.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { channelTypeEnum, retailers } from '../database/schema/index.js';
import { percentSchema, validate } from '../products/catalog.validation.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo ${max} caracteres`)
    .nullish()
    .transform((v) => v || null);

const updateSchema = z.object({
  name: z.string().trim().min(1, 'Falta el nombre').max(120).optional(),
  legalName: optionalText(200),
  taxId: optionalText(20),
  channelType: z.enum(channelTypeEnum.enumValues).optional(),
  commissionPct: percentSchema.optional(),
  paymentDays: z.coerce.number({ error: 'Días de pago inválidos' }).int().min(0, 'Mínimo 0 días').max(365, 'Máximo 365 días').optional(),
  paymentBase: z.enum(['ORDEN', 'DESPACHO']).optional(),
  contact: optionalText(500),
  commercialTerms: optionalText(2000),
  isActive: z.boolean().optional(),
});

/**
 * Maestra de retailers (los crean los adaptadores de carga; aquí se completan sus datos).
 *   GET   /api/retailers       con N° de órdenes y última venta
 *   PATCH /api/retailers/:id   (solo ADMIN)
 */
@Controller('retailers')
export class RetailersController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  list() {
    return this.db
      .select({
        id: retailers.id,
        code: retailers.code,
        name: retailers.name,
        legalName: retailers.legalName,
        taxId: retailers.taxId,
        channelType: retailers.channelType,
        commissionPct: sql<number>`${retailers.commissionPct}::float8`,
        paymentDays: retailers.paymentDays,
        paymentBase: retailers.paymentBase,
        contact: retailers.contact,
        commercialTerms: retailers.commercialTerms,
        isActive: retailers.isActive,
        orders: sql<number>`(select count(distinct s.order_number) from sales_records s where s.retailer_id = "retailers"."id")::int`,
        lastOrderDate: sql<string | null>`(select max(s.order_date)::text from sales_records s where s.retailer_id = "retailers"."id")`,
      })
      .from(retailers)
      .orderBy(asc(retailers.name));
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(updateSchema, body);
    const sent = body && typeof body === 'object' ? Object.keys(body) : [];
    const changes = Object.fromEntries(Object.entries(data).filter(([k, v]) => sent.includes(k) && v !== undefined));
    const [row] = await this.db.update(retailers).set(changes).where(eq(retailers.id, id)).returning({ id: retailers.id });
    if (!row) throw new NotFoundException('Retailer no encontrado');
    return { ok: true };
  }
}
