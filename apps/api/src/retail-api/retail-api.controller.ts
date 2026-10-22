import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { RetailApiService } from './retail-api.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

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
 *   POST /api/retail-api/:provider/orders/sync { from, to }   trae órdenes (en segundo plano)
 *   POST /api/retail-api/:provider/products/sync              trae productos (en segundo plano)
 *   GET  /api/retail-api/jobs/:id                       avance de una sincronización
 *   GET  /api/retail-api/orders?provider=&from=&to=
 *   GET  /api/retail-api/orders/:id/raw
 *   GET  /api/retail-api/products?provider=
 */
@Controller('retail-api')
export class RetailApiController {
  constructor(private readonly service: RetailApiService) {}

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
}
