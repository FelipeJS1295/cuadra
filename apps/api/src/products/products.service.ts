import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { PRICING_CHANNELS, suggestedPrice, targetNet, type PricingChannelCode } from '@cuadra/shared';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { productChannelCosts, products, productSupplies, retailers, supplies } from '../database/schema/index.js';

/** Nombre comercial de cada retailer, por si hay que crearlo (igual que en los adaptadores) */
const RETAILER_NAMES: Record<PricingChannelCode, string> = {
  CENCOSUD: 'Cencosud',
  WALMART: 'Walmart',
  FALABELLA: 'Falabella',
  HITES: 'Hites',
};

export type ChannelInput = Partial<
  Record<PricingChannelCode, { commissionPct: string | null; logisticsCost: string | null }>
>;

export interface ProductInput {
  skuMaster: string;
  name: string;
  provisionalCost: string;
  profitPct?: string;
  returnsPct?: string;
  channels?: ChannelInput;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Productos master con su comisión/logística por retailer y el precio sugerido en cada uno */
  async list(onlyId?: string) {
    const rows = await this.db
      .select()
      .from(products)
      .where(onlyId ? eq(products.id, onlyId) : undefined)
      .orderBy(asc(products.name));
    if (rows.length === 0) return [];

    const costs = await this.db
      .select({
        productId: productChannelCosts.productId,
        code: retailers.code,
        commissionPct: productChannelCosts.commissionPct,
        logisticsCost: productChannelCosts.logisticsCost,
      })
      .from(productChannelCosts)
      .innerJoin(retailers, eq(productChannelCosts.retailerId, retailers.id))
      .where(inArray(productChannelCosts.productId, rows.map((r) => r.id)));

    // Receta (fabricantes): cuántos insumos lleva y cuánto cuesta
    const recipes = await this.db
      .select({
        productId: productSupplies.productId,
        items: sql<number>`count(*)::int`,
        cost: sql<number>`sum(${productSupplies.quantity} * ${supplies.netCost})::float8`,
      })
      .from(productSupplies)
      .innerJoin(supplies, eq(supplies.id, productSupplies.supplyId))
      .where(inArray(productSupplies.productId, rows.map((r) => r.id)))
      .groupBy(productSupplies.productId);

    return rows.map((p) => {
      const cost = Number(p.provisionalCost);
      const profitPct = Number(p.profitPct);
      const returnsPct = Number(p.returnsPct);

      const channels = Object.fromEntries(
        PRICING_CHANNELS.map(({ code }) => {
          const c = costs.find((x) => x.productId === p.id && x.code === code);
          const commissionPct = c?.commissionPct ?? null;
          const logisticsCost = c?.logisticsCost ?? null;
          const price = suggestedPrice({
            cost,
            profitPct,
            returnsPct,
            commissionPct: commissionPct === null ? null : Number(commissionPct),
            logisticsCost: logisticsCost === null ? null : Number(logisticsCost),
          });
          return [
            code,
            {
              commissionPct,
              logisticsCost,
              suggestedPrice: price?.price ?? null,
              netAtPrice: price ? Math.round(price.netAtPrice) : null,
            },
          ];
        }),
      );

      return {
        id: p.id,
        skuMaster: p.skuMaster,
        name: p.name,
        provisionalCost: p.provisionalCost,
        /** Receta de insumos (fabricantes). Si tiene, el costo sale de ella */
        recipe: (() => {
          const rc = recipes.find((x) => x.productId === p.id);
          return rc ? { items: rc.items, cost: Math.round(rc.cost) } : null;
        })(),
        profitPct: p.profitPct,
        returnsPct: p.returnsPct,
        /** Neto que debemos recibir por unidad */
        targetNet: Math.round(targetNet(cost, profitPct, returnsPct)),
        channels,
      };
    });
  }

  async findOne(id: string) {
    const [row] = await this.list(id);
    if (!row) throw new NotFoundException('Producto no encontrado');
    return row;
  }

  async create(input: ProductInput) {
    const { channels, ...data } = input;
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(products).values(data).returning({ id: products.id });
      if (channels) await this.saveChannels(tx, row.id, channels);
      return row.id;
    });
    return this.findOne(id);
  }

  async update(id: string, input: Partial<ProductInput>) {
    const { channels, ...data } = input;
    await this.db.transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        const [row] = await tx.update(products).set(data).where(eq(products.id, id)).returning({ id: products.id });
        if (!row) throw new NotFoundException('Producto no encontrado');
      } else {
        const [row] = await tx.select({ id: products.id }).from(products).where(eq(products.id, id));
        if (!row) throw new NotFoundException('Producto no encontrado');
      }
      if (channels) await this.saveChannels(tx, id, channels);
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    const [row] = await this.db.delete(products).where(eq(products.id, id)).returning({ id: products.id });
    if (!row) throw new NotFoundException('Producto no encontrado');
    return { deleted: true };
  }

  /** Guarda (crea o actualiza) la comisión y logística de cada retailer recibido */
  private async saveChannels(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    productId: string,
    channels: ChannelInput,
  ) {
    for (const [code, values] of Object.entries(channels) as [PricingChannelCode, ChannelInput[PricingChannelCode]][]) {
      if (!values) continue;
      await tx
        .insert(retailers)
        .values({ code, name: RETAILER_NAMES[code] })
        .onConflictDoNothing({ target: [retailers.tenantId, retailers.code] });
      const [retailer] = await tx.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, code));

      await tx
        .insert(productChannelCosts)
        .values({ productId, retailerId: retailer.id, ...values })
        .onConflictDoUpdate({
          target: [productChannelCosts.productId, productChannelCosts.retailerId],
          set: { ...values, updatedAt: new Date() },
        });
    }
  }

  // ------------------------------------------------------------------ Receta (fabricantes)

  /** Insumos que lleva un producto, con su costo */
  async recipe(productId: string) {
    const [p] = await this.db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, productId));
    if (!p) throw new NotFoundException('Producto no encontrado');
    const items = await this.db
      .select({
        supplyId: supplies.id,
        sku: supplies.sku,
        name: supplies.name,
        unit: supplies.unit,
        unitCost: supplies.netCost,
        quantity: productSupplies.quantity,
      })
      .from(productSupplies)
      .innerJoin(supplies, eq(supplies.id, productSupplies.supplyId))
      .where(eq(productSupplies.productId, productId))
      .orderBy(asc(supplies.name));
    const rows = items.map((i) => ({
      ...i,
      unitCost: Number(i.unitCost),
      quantity: Number(i.quantity),
      cost: Math.round(Number(i.unitCost) * Number(i.quantity)),
    }));
    return { productId, name: p.name, items: rows, cost: rows.reduce((n, i) => n + i.cost, 0) };
  }

  /**
   * Guarda la receta completa (reemplaza la anterior). El costo del producto pasa a ser
   * el de la receta, así todo Cuadra (ventas, precios sugeridos, cuadratura) lo usa.
   */
  async saveRecipe(productId: string, items: { supplyId: string; quantity: number }[]) {
    await this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId));
      if (!p) throw new NotFoundException('Producto no encontrado');
      await tx.delete(productSupplies).where(eq(productSupplies.productId, productId));
      const merged = new Map<string, number>();
      for (const i of items) if (i.quantity > 0) merged.set(i.supplyId, (merged.get(i.supplyId) ?? 0) + i.quantity);
      if (merged.size) {
        await tx.insert(productSupplies).values([...merged].map(([supplyId, quantity]) => ({ productId, supplyId, quantity: String(quantity) })));
      }
    });
    await this.recomputeCosts([productId]);
    return this.recipe(productId);
  }

  /** Recalcula el costo de los productos con receta (al cambiar la receta o el costo de un insumo) */
  async recomputeCosts(productIds?: string[]) {
    await this.db.execute(sql`
      update products p set provisional_cost = round(r.cost, 2), updated_at = now()
      from (
        select ps.product_id, sum(ps.quantity * s.net_cost) as cost
        from product_supplies ps join supplies s on s.id = ps.supply_id
        ${productIds ? sql`where ps.product_id in ${productIds}` : sql``}
        group by ps.product_id
      ) r
      where p.id = r.product_id
    `);
  }

  /** Productos que usan un insumo (para recalcular su costo) */
  async productsUsing(supplyId: string) {
    const rows = await this.db.select({ id: productSupplies.productId }).from(productSupplies).where(eq(productSupplies.supplyId, supplyId));
    return rows.map((r) => r.id);
  }
}
