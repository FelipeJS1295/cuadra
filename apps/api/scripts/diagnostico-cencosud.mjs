/**
 * Diagnóstico: por qué la liquidación de Cencosud (archivo) no cuadra con las ventas de Paris (API).
 *
 * Uso (desde la raíz del proyecto):  node apps/api/scripts/diagnostico-cencosud.mjs
 * Deja el resultado en _pruebas/diagnostico-cencosud.json. No guarda nombres, RUT, correos
 * ni direcciones de clientes: solo números de orden, estructura y montos.
 */
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: resolve(root, '.env') });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

/** Estructura de un JSON sin datos personales: nombres de campos y solo los valores que parecen N° de orden o montos */
const SAFE = /order|orden|number|numero|id$|^id|status|estado|sku|price|precio|total|amount|monto|cost|quantity|cantidad|date|fecha|created/i;
const PERSONAL = /name|nombre|email|mail|phone|fono|address|direcc|street|calle|rut|document|customer|client/i;
function shape(v, depth = 0) {
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => shape(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (PERSONAL.test(k) && (x === null || typeof x !== 'object')) out[k] = '(oculto)';
      else if (x && typeof x === 'object') out[k] = shape(x, depth + 1);
      else out[k] = SAFE.test(k) ? x : typeof x;
    }
    return out;
  }
  return v;
}

const q = async (text, params = []) => (await db.query(text, params)).rows;
const report = { generado: new Date().toISOString() };

const tenants = await q(`select id, name from tenants order by created_at`);
report.empresas = [];
for (const t of tenants) {
  const tid = t.id;
  const [ret] = await q(`select id from retailers where tenant_id = $1 and code = 'CENCOSUD'`, [tid]);
  if (!ret) continue;
  const e = { empresa: t.name };

  e.ordenesApi = (await q(`select count(*)::int as n from retail_api_orders where tenant_id = $1 and provider = 'CENCOSUD'`, [tid]))[0].n;
  e.muestraOrdenesApi = (
    await q(
      `select external_id, order_number, customer_order_id, status, items_count, raw from retail_api_orders
       where tenant_id = $1 and provider = 'CENCOSUD' order by synced_at desc limit 3`,
      [tid],
    )
  ).map((o) => ({ ...o, raw: shape(o.raw) }));

  e.ventas = (
    await q(
      `select coalesce(raw->>'__origen', 'ARCHIVO') as origen, count(*)::int as lineas, count(distinct order_number)::int as ordenes,
         min(order_date)::text as desde, max(order_date)::text as hasta
       from sales_records where retailer_id = $1 group by 1`,
      [ret.id],
    )
  );
  e.muestraVentas = await q(
    `select order_number, order_id, external_item_id, seller_sku, paid_price::float8, status, fulfillment, coalesce(raw->>'__origen', 'ARCHIVO') as origen
     from sales_records where retailer_id = $1 order by order_date desc nulls last limit 8`,
    [ret.id],
  );

  e.liquidacion = (
    await q(
      `select count(*)::int as lineas, count(distinct order_number)::int as ordenes, min(transaction_date)::text as desde, max(transaction_date)::text as hasta,
         string_agg(distinct coalesce(channel, 'NORMAL'), ', ') as modalidades
       from settlement_records where retailer_id = $1`,
      [ret.id],
    ).catch(async () =>
      q(`select count(*)::int as lineas, count(distinct order_number)::int as ordenes from settlement_records where retailer_id = $1`, [ret.id]),
    )
  )[0];
  e.muestraLiquidacion = await q(
    `select order_number, sale_item_id, seller_sku, kind, amount_gross::float8 from settlement_records
     where retailer_id = $1 and kind = 'PRODUCT_PAYMENT' order by transaction_date desc nulls last limit 8`,
    [ret.id],
  );

  // ¿Cuántas órdenes de la liquidación calzan con ventas, y de qué forma?
  e.cruce = (
    await q(
      `with liq as (select distinct order_number as o from settlement_records where retailer_id = $1 and kind = 'PRODUCT_PAYMENT' and order_number is not null),
            v as (select distinct order_number, order_id from sales_records where retailer_id = $1)
       select
         (select count(*) from liq)::int as ordenes_liquidadas,
         (select count(*) from liq where o in (select order_number from v))::int as igual_a_n_orden,
         (select count(*) from liq where o in (select order_id from v where order_id is not null))::int as igual_a_orden_id,
         (select count(*) from liq where exists (select 1 from v where v.order_number like liq.o || '-%' or liq.o like v.order_number || '-%'))::int as calza_con_sufijo,
         (select count(*) from liq where regexp_replace(o, '\\D', '', 'g') <> '' and regexp_replace(o, '\\D', '', 'g') in (select regexp_replace(order_number, '\\D', '', 'g') from v))::int as calza_solo_numeros`,
      [ret.id],
    )
  )[0];
  report.empresas.push(e);
}

mkdirSync(resolve(root, '_pruebas'), { recursive: true });
const file = resolve(root, '_pruebas', 'diagnostico-cencosud.json');
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`Listo: ${file}`);
await db.end();
