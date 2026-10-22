import { boolean, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';

/**
 * Roles dentro de una empresa:
 *  DUENO     todo, incluye usuarios, plan y claves (SII, retailers)
 *  ADMIN     todo menos plan
 *  OPERADOR  carga archivos, emite documentos, asigna; ve todo
 *  LECTURA   solo mira
 */
export const userRoleEnum = pgEnum('user_role', ['DUENO', 'ADMIN', 'OPERADOR', 'LECTURA']);

/** Personas. Un usuario puede pertenecer a varias empresas (ej: un contador) */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Correo para iniciar sesión, en minúsculas y único */
  email: varchar('email', { length: 160 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  /** Contraseña cifrada (scrypt) */
  passwordHash: varchar('password_hash', { length: 200 }).notNull(),
  /** Administra el sistema completo (todas las empresas) */
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  /** Debe cambiar la contraseña al entrar (usuarios invitados) */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Qué empresas puede usar cada persona y con qué rol */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('LECTURA'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_user_tenant_uq').on(t.userId, t.tenantId)],
);

export type User = typeof users.$inferSelect;
export type UserRole = (typeof userRoleEnum.enumValues)[number];
