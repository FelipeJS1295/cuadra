import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Roles } from '../auth/decorators.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { supplies } from '../database/schema/index.js';
import { costSchema, nameSchema, rethrowDuplicate, skuSchema, validate } from './catalog.validation.js';
import { ProductsService } from './products.service.js';

const createSchema = z.object({
  sku: skuSchema,
  name: nameSchema,
  netCost: costSchema,
  unit: z.string().trim().min(1, 'Falta la unidad').max(20).optional(),
});
const updateSchema = createSchema.partial();

/**
 * Insumos (tela, espuma, patas...).
 *   GET    /api/supplies        lista, ordenada por nombre
 *   POST   /api/supplies        crea  { sku, name, netCost, unit? }
 *   PATCH  /api/supplies/:id    edita uno o varios campos
 *   DELETE /api/supplies/:id    elimina
 */
@Controller('supplies')
export class SuppliesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly products: ProductsService,
  ) {}

  /** Lista con cuántos productos lo usan en su receta */
  @Get()
  list() {
    return this.db
      .select({
        id: supplies.id,
        sku: supplies.sku,
        name: supplies.name,
        netCost: supplies.netCost,
        unit: supplies.unit,
        usedIn: sql<number>`(select count(*) from product_supplies ps where ps.supply_id = "supplies"."id")::int`,
      })
      .from(supplies)
      .orderBy(asc(supplies.name));
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Post()
  async create(@Body() body: unknown) {
    const data = validate(createSchema, body);
    try {
      const [row] = await this.db.insert(supplies).values(data).returning();
      return row;
    } catch (err) {
      rethrowDuplicate(err, data.sku);
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(updateSchema, body);
    if (Object.keys(data).length === 0) return this.findOne(id);
    try {
      const [row] = await this.db.update(supplies).set(data).where(eq(supplies.id, id)).returning();
      if (!row) throw new NotFoundException('Insumo no encontrado');
      // Cambió el costo: se recalcula el costo de los productos que lo llevan
      if (data.netCost !== undefined) {
        const ids = await this.products.productsUsing(id);
        if (ids.length) await this.products.recomputeCosts(ids);
      }
      return row;
    } catch (err) {
      rethrowDuplicate(err, data.sku ?? '');
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const ids = await this.products.productsUsing(id);
    const [row] = await this.db.delete(supplies).where(eq(supplies.id, id)).returning({ id: supplies.id });
    if (!row) throw new NotFoundException('Insumo no encontrado');
    if (ids.length) await this.products.recomputeCosts(ids);
    return { deleted: true };
  }

  private async findOne(id: string) {
    const [row] = await this.db.select().from(supplies).where(eq(supplies.id, id));
    if (!row) throw new NotFoundException('Insumo no encontrado');
    return row;
  }
}