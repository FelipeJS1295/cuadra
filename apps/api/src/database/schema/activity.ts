import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';
import { users } from './users.js';

/**
 * Actividad de los usuarios (para el administrador del sistema): ingresos, páginas que abren y
 * acciones que hacen, por empresa. Es una tabla del sistema: no se ve desde las empresas
 * (company_id en vez de tenant_id para que no le aplique el aislamiento por empresa).
 */
export const userActivity = pgTable(
  'user_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => tenants.id, { onDelete: 'cascade' }),
    /** LOGIN · LOGIN_FALLIDO · PAGINA · ACCION */
    kind: varchar('kind', { length: 20 }).notNull(),
    /** En palabras: "Subió ventas de Falabella", "Abrió Ventas" */
    description: text('description').notNull(),
    method: varchar('method', { length: 10 }),
    path: varchar('path', { length: 300 }),
    /** Respuesta del servidor (400 o más = falló) */
    status: integer('status'),
    ip: varchar('ip', { length: 60 }),
    userAgent: varchar('user_agent', { length: 300 }),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_activity_created_idx').on(t.createdAt),
    index('user_activity_user_idx').on(t.userId, t.createdAt),
    index('user_activity_company_idx').on(t.companyId, t.createdAt),
  ],
);
