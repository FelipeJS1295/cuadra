import { tenantId } from './tenant.js';
import {
  boolean,
  date,
  integer,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { retailers } from './retailers.js';

/**
 * Ventas de todos los retailers en una sola tabla.
 * Cada fila = 1 línea de venta (en Falabella, 1 "Item id" = 1 unidad).
 * Los nombres son genéricos: cada retailer mapea sus columnas a estos campos.
 */
export const salesRecords = pgTable(
  'sales_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),

    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),

    /** ID único de la línea en el sistema del retailer (Falabella: "Item id") */
    externalItemId: varchar('external_item_id', { length: 50 }).notNull(),

    // --- Producto ---
    sellerSku: varchar('seller_sku', { length: 60 }), // SKU del vendedor
    productName: text('product_name'), // Producto

    // --- Orden ---
    orderDate: date('order_date'), // Fecha de creacion (solo fecha, se muestra DD/MM/AAAA)
    orderNumber: varchar('order_number', { length: 50 }), // N° orden
    orderId: varchar('order_id', { length: 50 }), // Orden id
    documentType: varchar('document_type', { length: 20 }), // Documento requerido: BOLETA / FACTURA
    status: varchar('status', { length: 50 }), // Estado

    // --- Cliente y envío ---
    customerName: varchar('customer_name', { length: 200 }), // Nombre del cliente
    customerEmail: varchar('customer_email', { length: 200 }), // Email del cliente
    customerDocument: varchar('customer_document', { length: 20 }), // RUT/documento del cliente
    shippingName: varchar('shipping_name', { length: 200 }), // Nombre de envio
    shippingAddress: text('shipping_address'), // Direccion de envio 1 + 2 + 3
    shippingCommune: varchar('shipping_commune', { length: 100 }), // Comuna/Distrito/Localidad
    shippingRegion: varchar('shipping_region', { length: 100 }), // Region/Departamento

    // --- Facturación (cuando el cliente pide factura) ---
    billingLegalName: varchar('billing_legal_name', { length: 200 }), // Razón social
    billingTaxId: varchar('billing_tax_id', { length: 20 }), // RUT empresa
    billingActivity: varchar('billing_activity', { length: 200 }), // Giro
    billingAddress: text('billing_address'), // Dirección facturación

    // --- Montos (CLP). Numeric para no perder precisión ---
    paidPrice: numeric('paid_price', { precision: 14, scale: 2 }), // Precio pagado
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }), // Precio unitario
    shippingCost: numeric('shipping_cost', { precision: 14, scale: 2 }), // Costo de envio
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }), // Impuesto (Walmart)
    commissionAmount: numeric('commission_amount', { precision: 14, scale: 2 }), // Comisión
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }), // Descuento
    /** true = montos con IVA (Falabella, Cencosud). false = netos (Walmart) */
    amountsIncludeTax: boolean('amounts_include_tax').notNull().default(true),
    /** Unidades de la línea (Falabella y Cencosud: siempre 1) */
    quantity: integer('quantity').notNull().default(1),

    // --- Despacho ---
    carrier: varchar('carrier', { length: 100 }), // Operador Logistico
    fulfillment: varchar('fulfillment', { length: 50 }), // Tipo de fulfillment
    trackingCode: varchar('tracking_code', { length: 100 }), // Codigo de seguimiento
    dispatchDeadline: date('dispatch_deadline'), // Fecha limite de despacho
    /**
     * Venta enviada al proveedor dentro de Cuadra (empresas de compra y venta): a quién y cuándo.
     * El proveedor la recibe como venta de un canal con el nombre de esta empresa.
     */
    sentToSupplier: varchar('sent_to_supplier', { length: 200 }),
    sentToSupplierAt: timestamp('sent_to_supplier_at', { withTimezone: true }),
    /** Fecha en que el cliente recibió el producto (la informa la API del retailer) */
    deliveredAt: date('delivered_at'),

    /** Fila original completa del Excel, como respaldo */
    raw: jsonb('raw').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Evita duplicados: la misma línea del mismo retailer se actualiza, no se repite
    uniqueIndex('sales_records_retailer_item_uq').on(t.retailerId, t.externalItemId),
    // Índices para búsquedas frecuentes
    index('sales_records_order_date_idx').on(t.orderDate),
    index('sales_records_order_number_idx').on(t.orderNumber),
    index('sales_records_seller_sku_idx').on(t.sellerSku),
  ],
);

export type SalesRecord = typeof salesRecords.$inferSelect;
export type NewSalesRecord = typeof salesRecords.$inferInsert;