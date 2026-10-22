import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * Empresa del pedido en curso. Cada pedido de una empresa corre dentro de una transacción
 * con:
 *   SET LOCAL ROLE cuadra_app            -> rol sin privilegios: le aplican las políticas RLS
 *   app.tenant_id = <empresa>            -> las políticas solo dejan ver/escribir esa empresa
 * Así, aunque una consulta olvide filtrar por empresa, PostgreSQL no devuelve datos de otra.
 */
export interface TenantContext {
  tenantId: string;
  tx: Db;
}

export const tenantStore = new AsyncLocalStorage<TenantContext>();

export const currentTenantId = () => tenantStore.getStore()?.tenantId ?? null;

/** Ejecuta fn con la base "encerrada" en una empresa */
export async function withTenant<T>(base: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  return base.transaction(async (tx) => {
    await tx.execute(sql`set local role cuadra_app`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return tenantStore.run({ tenantId, tx: tx as unknown as Db }, fn);
  });
}

/**
 * Para trabajos en segundo plano lanzados desde un pedido (ej: sincronizar un retailer):
 * se sale del contexto del pedido (cuya transacción termina) y abre uno propio.
 */
export function runInBackground<T>(base: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.exit(() => withTenant(base, tenantId, fn));
}
