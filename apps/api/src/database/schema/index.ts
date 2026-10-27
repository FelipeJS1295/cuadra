/**
 * Esquema de la base de datos (Drizzle ORM).
 * Cada módulo del ERP tiene su archivo y se re-exporta desde aquí.
 *
 * Después de agregar o cambiar tablas:
 *   pnpm db:generate   -> crea el archivo de migración SQL en apps/api/drizzle
 *   pnpm db:migrate    -> lo aplica en Postgres
 */
export * from './retailers.js';
export * from './sales.js';
export * from './settlements.js';
export * from './products.js';
export * from './catalog.js';
export * from './users.js';
export * from './purchases.js';
export * from './documents.js';
export * from './retail-api.js';
export * from './tenant.js';
export * from './b2b.js';
