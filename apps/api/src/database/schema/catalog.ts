import { tenantId } from './tenant.js';
import { date, index, integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { products } from './products.js';
import { retailers } from './retailers.js';

/**
 * Catálogo de cada retailer: los productos tal como los tiene publicados ESE retailer
 * (un producto por color/variante). Se cargan desde el archivo que exporta cada uno.
 *
 * Cada producto del retail se asigna a un producto MASTER (ej: "Seccional Richter
 * Felpa Calipso" y "Seccional Richter Felpa Café" -> SEC-RICHTER).
 */
export const retailerProducts = pgTable(
  'retailer_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),

    /** SKU del producto en el retailer (ej: Paris "MK8400CF1K"). Clave única por retailer */
    retailerSku: varchar('retailer_sku', { length: 80 }).notNull(),

    /** SKU del vendedor (ej: "SECRICHFBNGCL"). Es el que viene en las ventas */
    sellerSku: varchar('seller_sku', { length: 80 }),

    name: varchar('name', { length: 300 }).notNull(),

    /** Precio normal y precio oferta (con IVA, como los publica el retailer) */
    listPrice: numeric('list_price', { precision: 14, scale: 2 }),
    offerPrice: numeric('offer_price', { precision: 14, scale: 2 }),
    offerFrom: date('offer_from'),
    offerTo: date('offer_to'),

    /** Estado de la publicación en el retailer (ej: Walmart "PUBLISHED"), si lo informa */
    status: varchar('status', { length: 40 }),
    /** Stock informado por el retailer, si lo trae el archivo */
    stock: integer('stock'),
    /** Foto del producto, si el archivo trae la URL */
    imageUrl: varchar('image_url', { length: 500 }),

    /** Producto master asignado. Si se elimina el master, queda sin asignar */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),

    /** Fila original del archivo, por si se necesita algún dato después */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('retailer_products_retailer_sku_uq').on(t.retailerId, t.retailerSku),
    index('retailer_products_seller_sku_idx').on(t.sellerSku),
    index('retailer_products_product_idx').on(t.productId),
  ],
);

export type RetailerProduct = typeof retailerProducts.$inferSelect;
export type NewRetailerProduct = typeof retailerProducts.$inferInsert;