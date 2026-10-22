import { tenantId } from './tenant.js';
import { date, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customerReceipts } from './purchases.js';
import { retailers } from './retailers.js';
import { users } from './users.js';

/**
 * Notas de crédito (DTE 61) que anulan o corrigen una boleta.
 *
 * Flujo con el Portal MIPYME (vía API Gateway):
 *   BORRADOR   el ERP creó el borrador en el portal: falta firmarlo allá
 *   EMITIDA    ya se firmó: se anotó su folio
 *   REGISTRADA se hizo fuera del ERP y solo se anotó (folio y monto)
 *   ERROR      el portal rechazó el borrador (ver siiResponse)
 * Solo EMITIDA y REGISTRADA rebajan el IVA débito del mes (por su fecha).
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),
    orderNumber: varchar('order_number', { length: 50 }).notNull(),
    /** Boleta a la que se le aplica */
    receiptId: uuid('receipt_id').references(() => customerReceipts.id, { onDelete: 'set null' }),
    /** N° (folio) y tipo de la boleta referenciada (se copian por si la boleta se borra) */
    receiptNumber: varchar('receipt_number', { length: 50 }).notNull(),
    receiptType: integer('receipt_type').notNull().default(39),
    receiptDate: date('receipt_date'),
    /** 1 = anula la boleta · 3 = corrige montos (devolución parcial) */
    refCode: integer('ref_code').notNull().default(1),
    reason: varchar('reason', { length: 90 }).notNull(),
    /** Monto con IVA que se rebaja */
    amountGross: numeric('amount_gross', { precision: 14, scale: 2 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('BORRADOR'),
    /** Código del borrador en el Portal MIPYME */
    draftCode: varchar('draft_code', { length: 40 }),
    /** Código del documento emitido en el Portal MIPYME (para bajar su PDF) */
    mipymeCode: varchar('mipyme_code', { length: 40 }),
    /** Folio de la nota ya emitida */
    folio: varchar('folio', { length: 30 }),
    /** Fecha de emisión (define el mes en el resumen de IVA) */
    issuedAt: date('issued_at'),
    siiResponse: jsonb('sii_response'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('credit_notes_order_idx').on(t.retailerId, t.orderNumber)],
);

export type CreditNote = typeof creditNotes.$inferSelect;

/**
 * Devoluciones de clientes y su logística inversa.
 *   SOLICITADA → EN_TRANSITO → RECIBIDA → CERRADA   (o RECHAZADA)
 */
export const productReturns = pgTable(
  'product_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),
    orderNumber: varchar('order_number', { length: 50 }).notNull(),
    requestedAt: date('requested_at').notNull(),
    /** TOTAL = toda la orden · PARCIAL = parte */
    scope: varchar('scope', { length: 10 }).notNull().default('TOTAL'),
    reason: varchar('reason', { length: 200 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('SOLICITADA'),
    receivedAt: date('received_at'),
    /** Estado del producto al volver: BUENO (se puede revender) · DANADO */
    productCondition: varchar('product_condition', { length: 20 }),
    /** Lo que se le devuelve al cliente (con IVA) */
    refundGross: numeric('refund_gross', { precision: 14, scale: 2 }),
    /** Cobro del retailer por la logística inversa (con IVA, positivo) */
    reverseLogisticsCost: numeric('reverse_logistics_cost', { precision: 14, scale: 2 }),
    /** Qué se hizo con el proveedor: NINGUNA · DEVUELTO · NC_PROVEEDOR */
    supplierAction: varchar('supplier_action', { length: 20 }).notNull().default('NINGUNA'),
    /** Monto que reconoce el proveedor (nota de crédito del proveedor, con IVA) */
    supplierCreditGross: numeric('supplier_credit_gross', { precision: 14, scale: 2 }),
    trackingCode: varchar('tracking_code', { length: 80 }),
    notes: text('notes'),
    creditNoteId: uuid('credit_note_id').references(() => creditNotes.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('product_returns_order_idx').on(t.retailerId, t.orderNumber)],
);

export type ProductReturn = typeof productReturns.$inferSelect;

/**
 * Guías de despacho (DTE 52) armadas como borrador en el Portal MIPYME.
 * Mismo flujo que las notas de crédito: BORRADOR -> se firma en el portal -> EMITIDA.
 */
export const dispatchGuides = pgTable(
  'dispatch_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    guideDate: date('guide_date').notNull(),
    /**
     * Motivo del traslado (IndTraslado del SII):
     * 1 venta · 2 venta por efectuar · 3 consignación · 5 traslado interno ·
     * 6 otros traslados no venta · 7 guía de devolución
     */
    transferType: integer('transfer_type').notNull().default(5),
    receptorRut: varchar('receptor_rut', { length: 12 }).notNull(),
    receptorName: varchar('receptor_name', { length: 100 }).notNull(),
    receptorActivity: varchar('receptor_activity', { length: 40 }),
    address: varchar('address', { length: 70 }),
    commune: varchar('commune', { length: 20 }),
    /** [{ name, quantity, price }] precio unitario con IVA (0 si es solo traslado) */
    items: jsonb('items').notNull(),
    totalGross: numeric('total_gross', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Orden o retailer relacionado (texto libre) */
    reference: varchar('reference', { length: 80 }),
    status: varchar('status', { length: 20 }).notNull().default('BORRADOR'),
    draftCode: varchar('draft_code', { length: 40 }),
    folio: varchar('folio', { length: 30 }),
    issuedAt: date('issued_at'),
    mipymeCode: varchar('mipyme_code', { length: 40 }),
    siiResponse: jsonb('sii_response'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('dispatch_guides_date_idx').on(t.guideDate)],
);
