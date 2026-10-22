import { tenantId } from './tenant.js';
import {
  date,
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
 * Tipo de movimiento, normalizado entre retailers:
 *  PRODUCT_PAYMENT = pago del precio del producto
 *  COMMISSION      = comisión por venta
 *  SHIPPING        = cobros/pagos de envío
 *  LOGISTICS       = cofinanciamiento logístico y otros cargos logísticos
 *  PENALTY         = multas (se agrupan en una sola línea "Multa sin OC")
 *  OTHER           = cualquier otro (ajustes, etc.)
 */
export const SETTLEMENT_KINDS = [
  'PRODUCT_PAYMENT',
  'COMMISSION',
  'SHIPPING',
  'LOGISTICS',
  'PENALTY',
  'OTHER',
] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

/** Clave con la que se agrupan todas las multas de un retailer en una sola línea */
export const PENALTY_GROUP_KEY = 'MULTA_SIN_OC';

/**
 * Liquidaciones: cada fila es UN movimiento de dinero informado por el retailer
 * (pago del producto, comisión, envío, etc.). Una venta tiene varios movimientos.
 */
export const settlementRecords = pgTable(
  'settlement_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),

    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),

    /** Clave única del movimiento dentro del retailer (la arma el servicio) */
    lineKey: varchar('line_key', { length: 300 }).notNull(),

    /** Modalidad, si el retailer liquida por separado (ej: Cencosud "FULFILLMENT"). Null = normal */
    channel: varchar('channel', { length: 30 }),

    // --- Con qué venta se cruza ---
    orderNumber: varchar('order_number', { length: 50 }), // Nº de orden
    saleItemId: varchar('sale_item_id', { length: 50 }), // Id Artículo (= Item id de la venta)
    sellerSku: varchar('seller_sku', { length: 60 }), // SKU vendedor
    productName: text('product_name'), // Nombre del producto

    // --- El movimiento ---
    transactionType: text('transaction_type'), // Tipo de transacción
    transactionCategory: varchar('transaction_category', { length: 100 }), // Categoría de transacciones
    kind: varchar('kind', { length: 30 }).$type<SettlementKind>().notNull().default('OTHER'),
    transactionDate: date('transaction_date'), // Fecha de transacción

    // --- Montos (CLP). Positivo = te pagan, negativo = te cobran ---
    amountNet: numeric('amount_net', { precision: 14, scale: 2 }), // Monto (Sin IVA)
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }), // IVA
    amountGross: numeric('amount_gross', { precision: 14, scale: 2 }), // Monto con IVA
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }), // % comisión (ej: 20.00)

    // --- Pago ---
    paymentStatus: varchar('payment_status', { length: 50 }), // Estado de pago
    statementNumber: varchar('statement_number', { length: 100 }), // Nº estado de cuenta
    paymentReference: varchar('payment_reference', { length: 100 }), // Referencia de pago Fpay
    taxDocumentNumber: varchar('tax_document_number', { length: 50 }), // N° Documento Tributario

    /** Fila original completa del Excel, como respaldo */
    raw: jsonb('raw').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('settlement_records_retailer_line_uq').on(t.retailerId, t.lineKey),
    index('settlement_records_sale_item_idx').on(t.retailerId, t.saleItemId),
    index('settlement_records_order_number_idx').on(t.orderNumber),
  ],
);

export type SettlementRecord = typeof settlementRecords.$inferSelect;
export type NewSettlementRecord = typeof settlementRecords.$inferInsert;