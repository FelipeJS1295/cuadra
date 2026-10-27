import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Roles, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { RetailApiService } from './retail-api.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

const pickupSchema = z.object({
  carrierCode: z.string().trim().min(1, 'Elige el courier'),
  warehouseCode: z.string().trim().min(1, 'Elige la bodega'),
  qty: z.coerce.number().int().min(1, 'Indica la cantidad de bultos').max(999),
  weight: z.coerce.number().positive('Indica el peso total').max(99999),
  size: z.enum(['xs', 's', 'm', 'l', 'c']),
  customSize: z.string().trim().max(60).optional(),
  pickupDate: dateSchema,
  rangeTime: z.enum(['AM', 'PM']),
  contactName: z.string().trim().min(2, 'Falta el nombre de contacto').max(100),
  contactPhone: z.string().trim().min(8, 'Falta el teléfono de contacto').max(20),
});
const labelsSchema = z.object({ orders: z.array(z.string().trim().min(1)).min(1).max(100) });

/** Desde el 20 del mes pasado hasta hoy (igual que Ventas) */
function defaultRange() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 2, 20)).toISOString().slice(0, 10), to: today };
}

/**
 * API Retail: ventas y productos traídos directo desde las APIs de los retailers.
 *   GET  /api/retail-api/connections                    estado de cada conexión (sin claves)
 *   PUT  /api/retail-api/connections/:provider          guarda credenciales (solo ADMIN)
 *   POST /api/retail-api/connections/:provider/test     prueba la conexión
 *   DELETE /api/retail-api/connections/:provider        desconecta y quita de Ventas lo que llegó por API (solo ADMIN)
 *   POST /api/retail-api/:provider/orders/sync { from, to }   trae órdenes (en segundo plano)
 *   POST /api/retail-api/:provider/products/sync              trae productos (en segundo plano)
 *   GET  /api/retail-api/jobs/:id                       avance de una sincronización
 *   GET  /api/retail-api/orders?provider=&from=&to=
 *   GET  /api/retail-api/orders/:id/raw
 *   GET  /api/retail-api/products?provider=
 *   POST /api/retail-api/:provider/products/update { sellerSku, changes }   modifica el producto en el retailer
 *   GET  /api/retail-api/:provider/products/changes?sku=                   historial de cambios enviados
 */
@Controller('retail-api')
export class RetailApiController {
  constructor(private readonly service: RetailApiService) {}

  // ---------- Envíame (Paris): retiros y etiquetas
  //   GET  /api/retail-api/enviame/status             ¿está conectado?
  //   GET  /api/retail-api/enviame/setup              bodegas, couriers y último retiro
  //   GET  /api/retail-api/enviame/pickups?from=&to=  retiros agendados
  //   POST /api/retail-api/enviame/pickups            crear retiro ("cita")
  //   POST /api/retail-api/enviame/labels { orders }  etiquetas en un PDF

  @Get('enviame/status')
  enviameStatus() {
    return this.service.enviameStatus();
  }

  @Get('enviame/setup')
  enviameSetup() {
    return this.service.enviameSetup();
  }

  @Get('enviame/pickups')
  enviamePickups(@Query('from') from?: string, @Query('to') to?: string) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    return this.service.enviamePickups(validate(dateSchema, from ?? shift(today, -3)), validate(dateSchema, to ?? shift(today, 7)));
  }

  @Post('enviame/pickups')
  createPickup(@Body() body: unknown) {
    return this.service.enviameCreatePickup(validate(pickupSchema, body));
  }

  @Post('enviame/labels')
  async labels(@Body() body: unknown, @Res() res: Response) {
    const { orders } = validate(labelsSchema, body);
    const r = await this.service.parisLabels(orders);
    const name = `etiquetas-paris-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    // Resumen en cabeceras (el cuerpo es el PDF)
    res.setHeader('X-Labels-Count', String(r.count));
    res.setHeader('X-Labels-Missing', encodeURIComponent(r.missing.join(',')));
    res.setHeader('Access-Control-Expose-Headers', 'X-Labels-Count, X-Labels-Missing');
    res.send(r.pdf);
  }

  @Get('connections')
  connections() {
    return this.service.connections();
  }

  @Roles('ADMIN')
  @Put('connections/:provider')
  save(@Param('provider') provider: string, @Body() body: unknown) {
    const input = validate(
      z.object({
        enabled: z.boolean().default(true),
        settings: z.record(z.string(), z.string().max(500)).default({}),
        secrets: z.record(z.string(), z.string().max(2000)).default({}),
      }),
      body,
    );
    return this.service.save(provider, input);
  }

  @Roles('ADMIN')
  @Delete('connections/:provider')
  disconnect(@Param('provider') provider: string) {
    return this.service.disconnect(provider);
  }

  @Post('connections/:provider/test')
  @HttpCode(200)
  test(@Param('provider') provider: string) {
    return this.service.test(provider);
  }

  @Post(':provider/orders/sync')
  @HttpCode(200)
  syncOrders(@Param('provider') provider: string, @Body() body: unknown) {
    const { from, to } = validate(z.object({ from: dateSchema, to: dateSchema }), body);
    return this.service.startOrders(provider, from, to);
  }

  @Post(':provider/products/sync')
  @HttpCode(200)
  syncProducts(@Param('provider') provider: string) {
    return this.service.startProducts(provider);
  }

  @Get('jobs/:id')
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.job(id);
  }

  @Get('orders')
  orders(@Query('provider') provider?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const d = defaultRange();
    return this.service.orders(validate(dateSchema, from || d.from), validate(dateSchema, to || d.to), provider || undefined);
  }

  @Get('orders/:id/raw')
  orderRaw(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.orderRaw(id);
  }

  @Get('products')
  products(@Query('provider') provider?: string) {
    return this.service.products(provider || undefined);
  }

  @Post(':provider/products/update')
  @HttpCode(200)
  updateProduct(@Param('provider') provider: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
    const input = validate(
      z.object({
        sellerSku: z.string().min(1).max(120),
        changes: z
          .object({
            stock: z.number().int().min(0).max(1000000).optional(),
            price: z.number().positive().max(100000000).optional(),
            salePrice: z.number().positive().max(100000000).nullable().optional(),
            saleFrom: day.optional(),
            saleTo: day.optional(),
            name: z.string().trim().min(3).max(300).optional(),
            description: z.string().trim().min(1).max(20000).optional(),
          })
          .strict(),
      }),
      body,
    );
    return this.service.updateProduct(provider, input.sellerSku, input.changes, user.name || user.email);
  }

  /** SKU padre/color asignados */
  @Get('sku-names')
  skuNames() {
    return this.service.skuNames();
  }

  /** Asocia un SKU del retailer a un SKU padre/color con nombre propio (se muestra en Ventas) */
  @Put(':provider/sku-names')
  setSkuName(@Param('provider') provider: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const input = validate(
      z.object({
        sellerSku: z.string().trim().min(1).max(120),
        parentSku: z
          .string()
          .trim()
          .min(1, 'Escribe el SKU padre/color')
          .max(80)
          .regex(/^[A-Za-z0-9._\-/ ]+$/, 'El SKU padre/color solo puede tener letras, números, guion, punto o barra'),
        name: z.string().trim().min(2, 'Escribe el nombre').max(300),
      }),
      body,
    );
    return this.service.setSkuName(provider, input.sellerSku, input.parentSku, input.name, user.name || user.email);
  }

  @Delete(':provider/sku-names/:sku')
  removeSkuName(@Param('provider') provider: string, @Param('sku') sku: string) {
    return this.service.removeSkuName(provider, sku);
  }

  @Get(':provider/products/changes')
  changes(@Param('provider') provider: string, @Query('sku') sku?: string) {
    return this.service.changes(provider, sku || undefined);
  }
}
