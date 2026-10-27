import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type SessionUser } from '../auth/decorators.js';
import { costSchema, validate } from '../products/catalog.validation.js';
import { RETURN_STATUSES, ReturnsService } from './returns.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato AAAA-MM-DD');
const optionalDate = dateSchema.nullish().transform((v) => v ?? null);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);
/** Monto opcional en pesos ("12.500", 12500); vacío -> null */
const optionalAmount = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    const r = costSchema.safeParse(v);
    if (!r.success) {
      ctx.addIssue({ code: 'custom', message: 'Los montos deben ser números mayores o iguales a 0' });
      return z.NEVER;
    }
    return r.data;
  });

const fields = {
  requestedAt: dateSchema,
  scope: z.enum(['TOTAL', 'PARCIAL']),
  reason: z.string({ error: 'Falta el motivo' }).trim().min(3, 'Escribe el motivo').max(200),
  status: z.enum(RETURN_STATUSES),
  receivedAt: optionalDate,
  productCondition: z
    .enum(['BUENO', 'DANADO'])
    .nullish()
    .transform((v) => v ?? null),
  refundGross: optionalAmount,
  reverseLogisticsCost: optionalAmount,
  supplierAction: z.enum(['NINGUNA', 'DEVUELTO', 'NC_PROVEEDOR']),
  supplierCreditGross: optionalAmount,
  trackingCode: optionalText(80),
  notes: optionalText(2000),
};

const createSchema = z.object({
  retailerCode: z.string({ error: 'Falta el retailer' }).min(1),
  orderNumber: z.string({ error: 'Falta la orden' }).trim().min(1).max(50),
  ...fields,
});

const receiveSchema = z.object({
  retailerCode: z.string().min(1),
  orderNumber: z.string().trim().min(1).max(50),
  code: z.string().trim().min(1).max(120),
  scope: z.enum(['TOTAL', 'PARCIAL']),
  products: z.array(z.string().max(300)).max(50).default([]),
  productCondition: z.enum(['BUENO', 'DANADO']),
  reason: z.string().trim().min(3, 'Elige el motivo').max(200),
  notes: optionalText(1000),
});

/**
 * Devoluciones y logística inversa.
 *   GET    /api/returns/lookup?code=   venta del código escaneado (cámara del teléfono)
 *   POST   /api/returns/lookup-text        { text } números leídos con la cámara (OCR)
 *   POST   /api/returns/receive        marca la devolución como recibida en bodega
 *   GET    /api/returns
 *   POST   /api/returns
 *   PATCH  /api/returns/:id
 *   DELETE /api/returns/:id
 */
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  list() {
    return this.returns.list();
  }

  @Get('lookup')
  lookup(@Query('code') code = '') {
    return this.returns.lookup(code);
  }

  /** Texto leído con la cámara (OCR): busca la orden con los números que trae */
  @Post('lookup-text')
  @Roles('DUENO', 'ADMIN', 'OPERADOR', 'LECTURA')
  lookupText(@Body() body: unknown) {
    return this.returns.lookupText(validate(z.object({ text: z.string().max(5000) }), body).text);
  }

  @Post('receive')
  receive(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.returns.receive(validate(receiveSchema, body), user?.id ?? null);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.returns.create(validate(createSchema, body), user?.id ?? null);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(z.object(fields).partial(), body);
    const sent = body && typeof body === 'object' ? Object.keys(body) : [];
    const changes = Object.fromEntries(Object.entries(data).filter(([k, v]) => sent.includes(k) && v !== undefined));
    return this.returns.update(id, changes);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.returns.remove(id);
  }
}
