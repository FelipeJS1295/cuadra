import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../database/database.module.js';
import { retailers, salesRecords } from '../database/schema/index.js';
import type { NormalizedOrder } from './providers/types.js';

/**
 * Las órdenes traídas por API pasan a Ventas (sales_records), igual que las de un archivo:
 * así aparecen en Ventas, Cobros, Inicio, boletas e IVA sin hacer nada más.
 *
 * Reglas:
 *  - Cada línea queda marcada en raw con { __origen: 'API' }.
 *  - La clave de la línea es la misma que usa el archivo del retailer
 *    (Falabella: id del ítem · Walmart: PO|línea · Paris: orden|SKU), así no se duplica.
 *  - Si la orden ya se cargó por archivo, no se toca (el archivo trae más datos: comisión, etc.).
 *  - Si después se sube el archivo, sus filas reemplazan a las de la API (ver sales-ingestion).
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const API_ORIGIN = 'API';

const cut = (v: string | null | undefined, max: number) => (v ? v.slice(0, max) : null);
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : String(Math.round(v * 100) / 100));

/** Fecha de la orden en Chile (AAAA-MM-DD) */
const dateCL = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d) : null);

/** Clave de la línea, la misma del archivo del retailer */
function lineKey(provider: string, o: NormalizedOrder, itemId: string, sku: string | null) {
  if (provider === 'WALMART') return `${o.orderNumber ?? o.externalId}|${itemId}`;
  if (provider === 'CENCOSUD') return `${o.orderNumber ?? o.externalId}|${sku ?? itemId}`;
  return itemId;
}

/** Id del retailer en la empresa (lo crea si no estuviera) */
export async function retailerIdFor(db: Database | Tx, code: string, name: string) {
  await db.insert(retailers).values({ code, name }).onConflictDoNothing({ target: [retailers.tenantId, retailers.code] });
  const [r] = await db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, code));
  return r.id;
}

/** Pasa una orden de la API a Ventas. Devuelve false si se omitió porque ya venía de un archivo */
export async function orderToSales(tx: Tx, provider: string, retailerId: string, apiOrderId: string, o: NormalizedOrder): Promise<boolean> {
  const numbers = [o.orderNumber, o.customerOrderId].filter((x): x is string => Boolean(x));
  if (!numbers.length) return false;

  // ¿Ya está cargada por archivo? Entonces manda el archivo
  const [fromFile] = await tx
    .select({ id: salesRecords.id })
    .from(salesRecords)
    .where(
      and(
        eq(salesRecords.retailerId, retailerId),
        sql`(${salesRecords.orderNumber} in ${numbers} or ${salesRecords.orderId} in ${numbers})`,
        sql`coalesce(${salesRecords.raw}->>'__origen', '') <> ${API_ORIGIN}`,
      ),
    )
    .limit(1);
  if (fromFile) return false;

  const base = {
    retailerId,
    orderDate: dateCL(o.orderDate),
    orderNumber: cut(o.orderNumber ?? o.externalId, 50),
    orderId: cut(o.customerOrderId ?? o.orderNumber ?? o.externalId, 50),
    status: cut(o.status, 50),
    customerName: cut(o.customerName, 200),
    customerEmail: cut(o.customerEmail, 200),
    customerDocument: cut(o.customerRut, 20),
    shippingName: cut(o.customerName, 200),
    shippingAddress: o.address,
    shippingCommune: cut(o.commune, 100),
    shippingRegion: cut(o.region, 100),
    // Los conectores entregan los montos con IVA
    amountsIncludeTax: true,
  };

  // Sin detalle de productos: una sola línea con el total de la orden
  const items = o.items.length
    ? o.items
    : [
        {
          externalItemId: 'orden',
          sellerSku: null,
          retailerSku: null,
          name: 'Orden sin detalle de productos',
          quantity: 1,
          unitPrice: o.total !== null ? o.total - (o.shippingTotal ?? 0) : null,
          paidPrice: o.total !== null ? o.total - (o.shippingTotal ?? 0) : null,
          shippingAmount: o.shippingTotal,
          status: o.status,
          raw: null,
        },
      ];

  const seen = new Map<string, number>();
  const rows = items.map((i) => {
    let key = lineKey(provider, o, i.externalItemId, i.sellerSku);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}|${n}`;
    const qty = Math.max(1, Math.round(i.quantity || 1));
    return {
      ...base,
      externalItemId: cut(key, 50)!,
      sellerSku: cut(i.sellerSku, 60),
      productName: i.name,
      quantity: qty,
      // En Ventas el precio pagado es por unidad; la API lo trae por línea
      paidPrice: money(i.paidPrice !== null ? i.paidPrice / qty : null),
      unitPrice: money(i.unitPrice),
      shippingCost: money(i.shippingAmount),
      status: cut(i.status ?? o.status, 50),
      raw: { __origen: API_ORIGIN, apiOrderId, provider, item: (i.raw ?? null) as unknown } as Record<string, unknown>,
    };
  });

  // Se reemplazan las líneas que esta orden tenía por API (por si cambió el detalle)
  await tx
    .delete(salesRecords)
    .where(
      and(
        eq(salesRecords.retailerId, retailerId),
        sql`${salesRecords.raw}->>'__origen' = ${API_ORIGIN}`,
        sql`${salesRecords.raw}->>'apiOrderId' = ${apiOrderId}`,
        rows.length ? sql`${salesRecords.externalItemId} not in ${rows.map((r) => r.externalItemId)}` : sql`true`,
      ),
    );
  await tx
    .insert(salesRecords)
    .values(rows)
    .onConflictDoUpdate({
      target: [salesRecords.retailerId, salesRecords.externalItemId],
      set: {
        orderDate: sql`excluded.order_date`,
        status: sql`excluded.status`,
        customerName: sql`excluded.customer_name`,
        customerEmail: sql`excluded.customer_email`,
        customerDocument: sql`excluded.customer_document`,
        shippingName: sql`excluded.shipping_name`,
        shippingAddress: sql`excluded.shipping_address`,
        shippingCommune: sql`excluded.shipping_commune`,
        shippingRegion: sql`excluded.shipping_region`,
        sellerSku: sql`excluded.seller_sku`,
        productName: sql`excluded.product_name`,
        quantity: sql`excluded.quantity`,
        paidPrice: sql`excluded.paid_price`,
        unitPrice: sql`excluded.unit_price`,
        shippingCost: sql`excluded.shipping_cost`,
        raw: sql`excluded.raw`,
      },
      // Nunca pisa una línea que vino de un archivo
      setWhere: sql`coalesce(${salesRecords.raw}->>'__origen', '') = ${API_ORIGIN}`,
    });
  return true;
}

/** Ids de líneas de API de esas órdenes (para que un archivo las reemplace) */
export async function deleteApiLinesOf(tx: Tx, retailerId: string, orderNumbers: string[]) {
  if (!orderNumbers.length) return 0;
  const res = await tx
    .delete(salesRecords)
    .where(
      and(
        eq(salesRecords.retailerId, retailerId),
        sql`${salesRecords.raw}->>'__origen' = ${API_ORIGIN}`,
        sql`(${inArray(salesRecords.orderNumber, orderNumbers)} or ${inArray(salesRecords.orderId, orderNumbers)})`,
      ),
    )
    .returning({ id: salesRecords.id });
  return res.length;
}
