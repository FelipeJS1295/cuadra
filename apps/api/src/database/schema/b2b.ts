import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenantId } from './tenant.js';

/**
 * Avisos para la empresa (campana del menú). Por ejemplo: "Jamaroff te envió 5 ventas".
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** VENTAS_RECIBIDAS · … */
    kind: varchar('kind', { length: 40 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    /** Página a la que lleva el aviso (ej: /ventas?retailer=CLI-76543210) */
    link: varchar('link', { length: 300 }),
    data: jsonb('data'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_tenant_idx').on(t.tenantId, t.createdAt)],
);
