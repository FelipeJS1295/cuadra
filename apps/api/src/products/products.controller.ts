import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PRICING_CHANNELS } from '@cuadra/shared';
import { z } from 'zod';
import { Roles } from '../auth/decorators.js';
import {
  costSchema,
  nameSchema,
  optionalCostSchema,
  optionalPercentSchema,
  percentSchema,
  rethrowDuplicate,
  skuSchema,
  validate,
} from './catalog.validation.js';
import { ProductsService } from './products.service.js';

/** Comisión y logística de un retailer */
const channelSchema = z.object({
  commissionPct: optionalPercentSchema,
  logisticsCost: optionalCostSchema,
});

/** { CENCOSUD: {...}, WALMART: {...}, ... } — todos opcionales */
const channelsSchema = z
  .object(Object.fromEntries(PRICING_CHANNELS.map(({ code }) => [code, channelSchema.optional()])))
  .partial();

const createSchema = z.object({
  skuMaster: skuSchema,
  name: nameSchema,
  provisionalCost: costSchema,
  profitPct: percentSchema.optional(),
  returnsPct: percentSchema.optional(),
  channels: channelsSchema.optional(),
});
const updateSchema = createSchema.partial();

/**
 * Productos MASTER (producto genérico, ej: "Seccional Richter") con su precio sugerido por retailer.
 *   GET    /api/products        lista, ordenada por nombre (incluye channels y precios sugeridos)
 *   POST   /api/products        crea  { skuMaster, name, provisionalCost, profitPct?, returnsPct?, channels? }
 *   PATCH  /api/products/:id    edita uno o varios campos
 *   DELETE /api/products/:id    elimina
 *
 * channels = { CENCOSUD: { commissionPct: "20", logisticsCost: "27990" }, WALMART: {...}, ... }
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}
  
  @Get()
  list() {
    return this.products.list();
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Post()
  async create(@Body() body: unknown) {
    const data = validate(createSchema, body);
    try {
      return await this.products.create(data);
    } catch (err) {
      rethrowDuplicate(err, data.skuMaster);
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(updateSchema, body);
    try {
      return await this.products.update(id, data);
    } catch (err) {
      rethrowDuplicate(err, data.skuMaster ?? '');
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(id);
  }
}