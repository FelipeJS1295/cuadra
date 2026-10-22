import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { PRICING_CHANNELS, suggestedPrice, targetNet, type PricingChannelCode } from '@cuadra/shared';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { productChannelCosts, products, retailers } from '../database/schema/index.js';

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
}