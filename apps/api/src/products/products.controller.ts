import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
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

const recipeSchema = z.object({
  items: z
    .array(z.object({ supplyId: z.uuid('Insumo inválido'), quantity: z.coerce.number().min(0, 'La cantidad no puede ser negativa').max(1e6) }))
    .max(200, 'Máximo 200 insumos por producto'),
});

/**
 * Productos MASTER (producto genérico, ej: "Seccional Richter") con su precio sugerido por retailer.
 *   GET    /api/products        lista, ordenada por nombre (incluye channels y precios sugeridos)
 *   POST   /api/products        crea  { skuMaster, name, provisionalCost, profitPct?, returnsPct?, channels? }
 *   PATCH  /api/products/:id    edita uno o varios campos
 *   DELETE /api/products/:id    elimina
 *   GET    /api/products/:id/receta   insumos que lleva (fabricantes)
 *   PUT    /api/products/:id/receta   { items: [{ supplyId, quantity }] } reemplaza la receta y recalcula el costo
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
      await this.products.update(id, data);
      // Si tiene receta, el costo lo manda la receta (no se puede cambiar a mano)
      await this.products.recomputeCosts([id]);
      return await this.products.findOne(id);
    } catch (err) {
      rethrowDuplicate(err, data.skuMaster ?? '');
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(id);
  }

  @Get(':id/receta')
  recipe(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.recipe(id);
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Put(':id/receta')
  saveRecipe(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { items } = validate(recipeSchema, body);
    return this.products.saveRecipe(id, items);
  }
}
