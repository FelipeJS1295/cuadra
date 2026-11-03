import { eq } from 'drizzle-orm';
import type { Database } from '../database/database.module.js';
import { deletedSales } from '../database/schema/index.js';

type Db = Pick<Database, 'select'>;

/**
 * Órdenes que el dueño eliminó de Ventas, para no volver a traerlas: al sincronizar por API,
 * al subir un archivo de ventas o de liquidación, o al recibirlas de un cliente de Cuadra.
 */
export async function deletedIndex(db: Db, retailerId: string) {
  const rows = await db
    .select({ orderNumber: deletedSales.orderNumber, other: deletedSales.otherNumbers, items: deletedSales.itemIds })
    .from(deletedSales)
    .where(eq(deletedSales.retailerId, retailerId));
  const numbers = new Set<string>();
  const items = new Set<string>();
  for (const r of rows) {
    numbers.add(r.orderNumber);
    for (const n of r.other ?? []) numbers.add(n);
    for (const i of r.items ?? []) items.add(i);
  }
  return {
    size: rows.length,
    /** true si alguno de los números de orden o de los ids de línea fue eliminado */
    has(orderNumbers: (string | null | undefined)[], itemIds: (string | null | undefined)[] = []) {
      if (!rows.length) return false;
      return orderNumbers.some((n) => !!n && numbers.has(n)) || itemIds.some((i) => !!i && items.has(i));
    },
  };
}
