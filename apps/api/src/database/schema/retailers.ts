import { tenantId } from './tenant.js';
import {
  uniqueIndex,
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** Tipo de canal de venta del retailer */
export const channelTypeEnum = pgEnum('channel_type', [
  'department_store', // Tienda por departamento (Falabella, Ripley, Paris)
  'supermarket', // Supermercado (Walmart/Lider, Jumbo, Unimarc)
  'marketplace', // Marketplace (Mercado Libre, Falabella.com Marketplace)
  'ecommerce', // Tienda online propia (Shopify)
  'other',
]);

export const retailers = pgTable('retailers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),

  /** Código corto y único, se usa en los archivos y adaptadores. Ej: FALABELLA */
  code: varchar('code', { length: 30 }).notNull(),

  /** Nombre comercial. Ej: Falabella */
  name: varchar('name', { length: 120 }).notNull(),

  /** Razón social. Ej: Falabella Retail S.A. */
  legalName: varchar('legal_name', { length: 200 }),

  /** RUT del retailer. Ej: 77.261.280-K */
  taxId: varchar('tax_id', { length: 20 }),

  channelType: channelTypeEnum('channel_type').notNull().default('department_store'),

  /** Comisión contractual en %. Ej: 18.50. Numeric para no perder precisión */
  commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }).notNull().default('0'),

  /** Días de pago desde la venta o la factura. Ej: 30, 60, 90 */
  paymentDays: integer('payment_days').notNull().default(30),

  /**
   * Desde qué fecha se cuentan los días de pago (cuentas por cobrar):
   *  ORDEN     fecha de la orden (venta)
   *  DESPACHO  fecha límite de despacho (aprox. de la entrega: los archivos no traen la entrega real)
   */
  paymentBase: varchar('payment_base', { length: 20 }).notNull().default('ORDEN'),

  /**
   * Cómo paga el retailer (ver @cuadra/shared payment-calendar):
   *  DIAS             paymentDays corridos desde paymentBase
   *  QUINCENAL        cierra el 14 y fin de mes; paga paymentDays hábiles después (Walmart)
   *  HABILES_ENTREGA  paymentDays hábiles después de la entrega (Falabella)
   *  SEMANAL          el paymentWeekday paga lo entregado la semana anterior (Paris)
   */
  paymentRule: varchar('payment_rule', { length: 20 }).notNull().default('DIAS'),
  /** SEMANAL: día de pago (0 domingo … 3 miércoles … 6 sábado) */
  paymentWeekday: integer('payment_weekday').notNull().default(3),

  /** Contacto comercial / KAM (nombre, correo, teléfono) */
  contact: text('contact'),

  /** Condiciones comerciales en texto libre (rappel, aportes, etc.) */
  commercialTerms: text('commercial_terms'),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('retailers_tenant_code_uq').on(t.tenantId, t.code)]);

export type Retailer = typeof retailers.$inferSelect;
export type NewRetailer = typeof retailers.$inferInsert;