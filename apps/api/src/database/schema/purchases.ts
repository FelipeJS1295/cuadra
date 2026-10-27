import { tenantId } from './tenant.js';
import { date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { retailers } from './retailers.js';
import { users } from './users.js';

/**
 * Proveedores: a quienes les compramos los productos que se venden en los retailers.
 * Se crean solos al guardar un documento con un nombre nuevo.
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    name: varchar('name', { length: 200 }).notNull(),
    /** RUT del proveedor (12345678-9). Se completa al traer sus facturas del SII */
    taxId: varchar('tax_id', { length: 12 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Sin duplicados aunque cambien mayúsculas/minúsculas ("Muebles Sur" = "muebles sur")
  (t) => [
    uniqueIndex('suppliers_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex('suppliers_tax_id_uq').on(t.tenantId, t.taxId).where(sql`${t.taxId} is not null`),
  ],
);

/**
 * Documentos de compra (facturas) del proveedor.
 * Un documento puede cubrir varias órdenes (una línea por orden).
 */
export const purchaseDocuments = pgTable(
  'purchase_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    /** N° del documento (factura) del proveedor */
    documentNumber: varchar('document_number', { length: 50 }).notNull(),
    /** Fecha de emisión de la factura (define el mes del IVA crédito) */
    issueDate: date('issue_date'),
    /** Tipo SII: 33 factura · 34 exenta · 46 compra · 56 nota de débito · 61 nota de crédito */
    documentType: integer('document_type').notNull().default(33),
    /**
     * Montos del documento según el Registro de Compras del SII (con signo positivo).
     * Si están, mandan sobre la suma de las órdenes asignadas.
     */
    siiExempt: numeric('sii_exempt', { precision: 14, scale: 2 }),
    siiNet: numeric('sii_net', { precision: 14, scale: 2 }),
    siiVat: numeric('sii_vat', { precision: 14, scale: 2 }),
    siiTotal: numeric('sii_total', { precision: 14, scale: 2 }),
    /** Estado en el RCV: REGISTRO, PENDIENTE, RECLAMADO, NO_INCLUIR */
    siiStatus: varchar('sii_status', { length: 20 }),
    siiImportedAt: timestamp('sii_imported_at', { withTimezone: true }),
    siiData: jsonb('sii_data'),
    /**
     * Factura emitida por un retailer (comisiones, logística). Su IVA ya se cuenta desde
     * la liquidación, así que no entra como compra ni como deuda con proveedores.
     */
    retailerId: uuid('retailer_id').references(() => retailers.id),
    /** Código del documento recibido en el Portal MIPYME (para su PDF) */
    mipymeCode: varchar('mipyme_code', { length: 40 }),
    /** Productos de la factura leídos de su XML (NmbItem, QtyItem, PrcItem…) */
    siiItems: jsonb('sii_items'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Una factura y una nota de crédito del mismo proveedor pueden tener el mismo N°
  (t) => [uniqueIndex('purchase_documents_supplier_number_uq').on(t.supplierId, t.documentType, t.documentNumber)],
);

/**
 * Líneas del documento: qué orden de la conciliación cubre y por cuánto (neto, sin IVA).
 * La orden se identifica igual que en la conciliación: retailer + clave de la fila
 * (Item id, N° de orden u Orden id según el retailer).
 */
export const purchaseDocumentLines = pgTable(
  'purchase_document_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => purchaseDocuments.id, { onDelete: 'cascade' }),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),
    /** Clave de la fila en la conciliación (itemId) */
    itemKey: varchar('item_key', { length: 80 }).notNull(),
    orderNumber: varchar('order_number', { length: 50 }),
    productName: text('product_name'),
    /** Monto neto (sin IVA) */
    amountNet: numeric('amount_net', { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_document_lines_uq').on(t.documentId, t.retailerId, t.itemKey),
    index('purchase_document_lines_item_idx').on(t.retailerId, t.itemKey),
  ],
);


/**
 * Boleta emitida al cliente final por una orden (producto + envío).
 * Una por orden; su IVA es el IVA débito de la venta.
 */
export const customerReceipts = pgTable(
  'customer_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id),
    orderNumber: varchar('order_number', { length: 50 }).notNull(),
    /** N° de la boleta */
    receiptNumber: varchar('receipt_number', { length: 50 }).notNull(),
    /** Total de la boleta, con IVA */
    totalGross: numeric('total_gross', { precision: 14, scale: 2 }).notNull(),
    /** Tipo de documento SII: 39 boleta afecta, 41 boleta exenta, 33 factura */
    documentType: integer('document_type').notNull().default(39),
    /**
     * REGISTRADA  se anotó a mano (emitida fuera del sistema)
     * EMITIENDO   se está emitiendo en el SII (bloquea un segundo intento)
     * EMITIDA     emitida desde el sistema (API Gateway)
     * REVISAR     el SII no confirmó: revisar en el portal antes de reintentar
     * BORRADOR    factura armada en el Portal MIPYME: falta firmarla allá
     */
    status: varchar('status', { length: 20 }).notNull().default('REGISTRADA'),
    /** Fecha de emisión en el SII */
    issuedAt: date('issued_at'),
    /** Factura (33) armada como borrador en MIPYME: código del borrador y del emitido */
    draftCode: varchar('draft_code', { length: 40 }),
    mipymeCode: varchar('mipyme_code', { length: 40 }),
    /** Datos del receptor de la factura (RUT, razón social, giro, dirección, comuna) */
    receptor: jsonb('receptor'),
    /** PDF de la boleta (base64) y su URL en el SII */
    pdfData: text('pdf_data'),
    pdfUrl: text('pdf_url'),
    /** Respuesta o error del SII (para revisar) */
    siiResponse: jsonb('sii_response'),
    /**
     * Envío del documento al portal del retailer (Paris exige subir la boleta de cada orden).
     * ENVIADA · ERROR · null (no se ha enviado o el retailer no lo pide)
     */
    retailStatus: varchar('retail_status', { length: 20 }),
    retailMessage: text('retail_message'),
    retailSentAt: timestamp('retail_sent_at', { withTimezone: true }),
    /** Id del documento en el retailer */
    retailRef: varchar('retail_ref', { length: 80 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('customer_receipts_order_uq').on(t.retailerId, t.orderNumber)],
);

export type CustomerReceipt = typeof customerReceipts.$inferSelect;

/**
 * Pagos a una factura del proveedor (abonos). La deuda de la factura es
 * su total con IVA menos la suma de sus pagos.
 */
export const purchaseDocumentPayments = pgTable(
  'purchase_document_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => purchaseDocuments.id, { onDelete: 'cascade' }),
    /** Monto pagado (con IVA, igual que el total de la factura) */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    paidAt: date('paid_at').notNull(),
    /** Transferencia, efectivo, cheque… */
    method: varchar('method', { length: 40 }),
    /** N° de operación o comentario */
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('purchase_document_payments_document_idx').on(t.documentId)],
);

export type Supplier = typeof suppliers.$inferSelect;
export type PurchaseDocument = typeof purchaseDocuments.$inferSelect;
export type PurchaseDocumentLine = typeof purchaseDocumentLines.$inferSelect;