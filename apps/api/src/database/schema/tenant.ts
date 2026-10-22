import { sql } from 'drizzle-orm';
import { date, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Empresas (clientes del sistema). Cada empresa ve SOLO sus datos: todas las tablas de
 * negocio tienen tenant_id y PostgreSQL lo exige con Row Level Security (ver migración RLS).
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Nombre de fantasía. Ej: Muebles del Sur */
  name: varchar('name', { length: 120 }).notNull(),
  /** Razón social y RUT (van en boletas y facturas) */
  legalName: varchar('legal_name', { length: 200 }),
  taxId: varchar('tax_id', { length: 12 }),
  /** Plan contratado: PRUEBA · BASICO · PRO */
  plan: varchar('plan', { length: 20 }).notNull().default('PRUEBA'),
  /** ACTIVA · SUSPENDIDA */
  status: varchar('status', { length: 20 }).notNull().default('ACTIVA'),
  trialEndsAt: date('trial_ends_at'),
  /** Pasos del asistente de inicio que ya se completaron o saltaron */
  onboarding: jsonb('onboarding').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Tenant = typeof tenants.$inferSelect;

/**
 * Columna tenant_id de las tablas de negocio. Si no se indica al insertar, toma la empresa
 * de la sesión actual (app.tenant_id, la fija la API en cada pedido).
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`(current_setting('app.tenant_id'))::uuid`)
    .references(() => tenants.id, { onDelete: 'cascade' });

/**
 * Configuración de cada empresa: datos no secretos (data) y claves cifradas (secrets),
 * por ejemplo el token de API Gateway y la clave del SII.
 */
export const tenantSettings = pgTable('tenant_settings', {
  tenantId: tenantId().primaryKey(),
  data: jsonb('data').notNull().default({}),
  secrets: text('secrets'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Registro de acciones importantes (quién emitió, anuló, cambió claves…) */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantId(),
  userId: uuid('user_id'),
  action: varchar('action', { length: 80 }).notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

