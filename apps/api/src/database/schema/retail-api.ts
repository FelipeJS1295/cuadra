import { tenantId } from './tenant.js';
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * API Retail: conexión directa con las APIs de los retailers (Falabella, Paris, Walmart).
 * Es una sección aparte: sus ventas y productos NO se mezclan con las cargadas por archivo.
 */

/** Credenciales y estado de la conexión con cada retailer (provider = código del retailer) */
export const retailApiConnections = pgTable('retail_api_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
  /** FALABELLA · CENCOSUD (Paris) · WALMART */
  provider: varchar('provider', { length: 20 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** Datos que no son secretos (usuario, seller id, URL base…) */
  settings: jsonb('settings').notNull().default({}),
  /** Claves (API key, client secret…) cifradas con AES-256-GCM */
  secrets: text('secrets'),
  /** SIN_PROBAR · OK · ERROR */
  status: varchar('status', { length: 20 }).notNull().default('SIN_PROBAR'),
  lastError: text('last_error'),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastOrdersSyncAt: timestamp('last_orders_sync_at', { withTimezone: true }),
  lastProductsSyncAt: timestamp('last_products_sync_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('retail_api_connections_uq').on(t.tenantId, t.provider)]);

/** Órdenes traídas por API */
export const retailApiOrders = pgTable(
  'retail_api_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** Id de la orden en el retailer */
    externalId: varchar('external_id', { length: 80 }).notNull(),
    /** N° de orden que ve el vendedor (Falabella OrderNumber, Walmart purchaseOrderId…) */
    orderNumber: varchar('order_number', { length: 80 }),
    /** N° de orden del cliente (Walmart customerOrderId) */
    customerOrderId: varchar('customer_order_id', { length: 80 }),
    orderDate: timestamp('order_date', { withTimezone: true }),
    status: varchar('status', { length: 60 }),
    customerName: varchar('customer_name', { length: 200 }),
    customerRut: varchar('customer_rut', { length: 20 }),
    customerEmail: varchar('customer_email', { length: 200 }),
    address: varchar('address', { length: 300 }),
    commune: varchar('commune', { length: 120 }),
    region: varchar('region', { length: 120 }),
    /** Total de la orden con IVA (productos + envío) */
    total: numeric('total', { precision: 14, scale: 2 }),
    shippingTotal: numeric('shipping_total', { precision: 14, scale: 2 }),
    itemsCount: integer('items_count').notNull().default(0),
    raw: jsonb('raw'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('retail_api_orders_uq').on(t.tenantId, t.provider, t.externalId),
    index('retail_api_orders_date_idx').on(t.orderDate),
  ],
);

/** Productos de cada orden traída por API */
export const retailApiOrderItems = pgTable(
  'retail_api_order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => retailApiOrders.id, { onDelete: 'cascade' }),
    externalItemId: varchar('external_item_id', { length: 80 }).notNull(),
    sellerSku: varchar('seller_sku', { length: 120 }),
    retailerSku: varchar('retailer_sku', { length: 120 }),
    name: varchar('name', { length: 300 }),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull().default('1'),
    /** Precio unitario con IVA */
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
    /** Lo pagado por la línea, con IVA (después de descuentos) */
    paidPrice: numeric('paid_price', { precision: 14, scale: 2 }),
    shippingAmount: numeric('shipping_amount', { precision: 14, scale: 2 }),
    status: varchar('status', { length: 60 }),
    raw: jsonb('raw'),
  },
  (t) => [uniqueIndex('retail_api_order_items_uq').on(t.orderId, t.externalItemId)],
);

/** Productos publicados en cada retailer, traídos por API */
export const retailApiProducts = pgTable(
  'retail_api_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    provider: varchar('provider', { length: 20 }).notNull(),
    sellerSku: varchar('seller_sku', { length: 120 }).notNull(),
    /** SKU / id del producto en el retailer (Falabella ShopSku, Walmart wpid…) */
    retailerSku: varchar('retailer_sku', { length: 120 }),
    name: varchar('name', { length: 300 }),
    brand: varchar('brand', { length: 120 }),
    /** Precio normal y de oferta, con IVA */
    price: numeric('price', { precision: 14, scale: 2 }),
    salePrice: numeric('sale_price', { precision: 14, scale: 2 }),
    stock: integer('stock'),
    status: varchar('status', { length: 60 }),
    url: varchar('url', { length: 500 }),
    imageUrl: varchar('image_url', { length: 500 }),
    raw: jsonb('raw'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('retail_api_products_uq').on(t.tenantId, t.provider, t.sellerSku)],
);
