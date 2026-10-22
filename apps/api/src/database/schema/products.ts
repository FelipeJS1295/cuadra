import { tenantId } from './tenant.js';
import { numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { retailers } from './retailers.js';

/**
 * Productos MASTER: el producto genérico, sin color ni variante.
 * Ej: "Seccional Richter". Las variantes (colores) y los SKU de cada retailer
 * se van a asociar a este master más adelante.
 */
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),

  /** SKU master, único. Ej: SEC-RICHTER */
  skuMaster: varchar('sku_master', { length: 60 }).notNull(),

  /** Nombre del producto genérico. Ej: Seccional Richter */
  name: varchar('name', { length: 200 }).notNull(),

  /**
   * Costo momentáneo (neto). Se usa mientras no se calcule el costo real
   * a partir de los insumos.
   */
  provisionalCost: numeric('provisional_cost', { precision: 14, scale: 2 }).notNull().default('0'),

  /** % de utilidad sobre el costo momentáneo. Ej: 20.00 */
  profitPct: numeric('profit_pct', { precision: 5, scale: 2 }).notNull().default('20'),

  /** % de devoluciones sobre el costo momentáneo. Ej: 5.00 */
  returnsPct: numeric('returns_pct', { precision: 5, scale: 2 }).notNull().default('5'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('products_tenant_sku_uq').on(t.tenantId, t.skuMaster)]);

/**
 * Insumos: materiales con los que se fabrica un producto (tela, espuma, patas...).
 * Más adelante se asociarán a los productos master para saber el costo real.
 */
export const supplies = pgTable('supplies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),

  /** SKU del insumo, único. Ej: INS-TELA-GRIS */
  sku: varchar('sku', { length: 60 }).notNull(),

  /** Nombre del insumo. Ej: Tela lino gris */
  name: varchar('name', { length: 200 }).notNull(),

  /** Costo neto (sin IVA) por unidad del insumo */
  netCost: numeric('net_cost', { precision: 14, scale: 2 }).notNull().default('0'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('supplies_tenant_sku_uq').on(t.tenantId, t.sku)]);

/**
 * Comisión y logística de cada producto master en cada retailer.
 * Con esto se calcula el precio sugerido para publicar (ver @cuadra/shared pricing).
 */
export const productChannelCosts = pgTable(
  'product_channel_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),

    /** % de comisión que cobra el retailer sobre el precio publicado. Ej: 20.00 */
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }),

    /** Cobro de logística por unidad, con IVA (como lo factura el retailer). Ej: 27990 */
    logisticsCost: numeric('logistics_cost', { precision: 14, scale: 2 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('product_channel_costs_uq').on(t.productId, t.retailerId)],
);

export type Product = typeof products.$inferSelect;
export type Supply = typeof supplies.$inferSelect;