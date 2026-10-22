import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Roles } from '../auth/decorators.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { supplies } from '../database/schema/index.js';
import { costSchema, nameSchema, rethrowDuplicate, skuSchema, validate } from './catalog.validation.js';

const createSchema = z.object({
  sku: skuSchema,
  name: nameSchema,
  netCost: costSchema,
});
const updateSchema = createSchema.partial();

/**
 * Insumos (tela, espuma, patas...).
 *   GET    /api/supplies        lista, ordenada por nombre
 *   POST   /api/supplies        crea  { sku, name, netCost }
 *   PATCH  /api/supplies/:id    edita uno o varios campos
 *   DELETE /api/supplies/:id    elimina
 */
@Controller('supplies')
export class SuppliesController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  list() {
    return this.db.select().from(supplies).orderBy(asc(supplies.name));
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
      return row;
    } catch (err) {
      rethrowDuplicate(err, data.sku ?? '');
    }
  }

  @Roles('ADMIN') // costos y precios: solo administradores
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.delete(supplies).where(eq(supplies.id, id)).returning({ id: supplies.id });
    if (!row) throw new NotFoundException('Insumo no encontrado');
    return { deleted: true };
  }

  private async findOne(id: string) {
    const [row] = await this.db.select().from(supplies).where(eq(supplies.id, id));
    if (!row) throw new NotFoundException('Insumo no encontrado');
    return row;
  }
}