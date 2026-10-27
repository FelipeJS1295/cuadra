/**
 * Diagnóstico: qué fechas informa cada retailer en las órdenes por despachar, para saber cuál es
 * la fecha en que hay que entregarle el producto al retailer / courier (Maestra de despachos).
 *
 * Uso (desde la raíz del proyecto):  node apps/api/scripts/diagnostico-fechas.mjs
 * Deja el resultado en _pruebas/diagnostico-fechas.json. No guarda nombres, RUT, correos
 * ni direcciones: solo los campos de fecha, estados y N° de orden.
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
const q = async (text, params = []) => (await db.query(text, params)).rows;

const DATE_KEY = /date|fecha|time|deadline|limit|promise|dispatch|despacho|ship|delivery|entrega|arrival|handling|sla|plazo|pickup|retiro|estimated/i;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}|^\d{2}[-/]\d{2}[-/]\d{4}|^\d{12,13}$/;
const PERSONAL = /name|nombre|email|mail|phone|fono|address|direcc|street|calle|rut|document|customer|client|comment/i;

/** Todos los campos que parecen fecha (ruta -> valor), o estados, en cualquier nivel */
function dates(v, path = '', out = {}, depth = 0) {
  if (depth > 7 || v === null || v === undefined) return out;
  if (Array.isArray(v)) {
    v.slice(0, 3).forEach((x, i) => dates(x, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (PERSONAL.test(k) && (x === null || typeof x !== 'object')) continue;
      if (x && typeof x === 'object') dates(x, p, out, depth + 1);
      else if ((DATE_KEY.test(k) && x !== '' && x !== null) || DATE_VALUE.test(String(x ?? '')) || /status|estado|type|tipo|carrier|courier|shipping_?(type|method|company)|logistic/i.test(k)) out[p] = x;
    }
  }
  return out;
}

const report = { generado: new Date().toISOString(), empresas: [] };
for (const t of await q(`select id, name from tenants order by created_at`)) {
  const e = { empresa: t.name, retailers: {} };
  // Líneas por despachar sin fecha límite (como las ve la Maestra de despachos)
  const pending = await q(
    `select r.code, s.order_number, s.order_id, s.status, s.dispatch_deadline::text as deadline, s.raw
       from sales_records s join retailers r on r.id = s.retailer_id
      where s.tenant_id = $1 and s.order_date >= current_date - 90
        and coalesce(s.status, '') !~* 'cancel|anulad|rechazad|entregad|deliver|despachad|shipped|en camino|transit'
      order by s.order_date desc`,
    [t.id],
  );
  for (const row of pending) {
    const r = (e.retailers[row.code] ??= { lineas: 0, sinFecha: 0, porOrigen: {}, muestras: [] });
    r.lineas++;
    if (!row.deadline) r.sinFecha++;
    const origen = row.raw?.__origen === 'API' ? 'API' : 'ARCHIVO';
    r.porOrigen[origen] = (r.porOrigen[origen] ?? 0) + 1;
    if (r.muestras.length >= 4 || row.deadline) continue;
    const muestra = { orden: row.order_number, ordenCliente: row.order_id, estado: row.status, fechaLimiteGuardada: row.deadline, origen };
    if (origen === 'API') {
      const [o] = await q(
        `select raw from retail_api_orders where tenant_id = $1 and provider = $2 and (order_number = $3 or customer_order_id = $3 or raw::text like '%' || $3 || '%') limit 1`,
        [t.id, row.code, row.order_number],
      );
      muestra.camposDeLaApi = o ? dates(o.raw) : '(no se encontró la orden de la API)';
    } else {
      muestra.camposDelArchivo = dates(row.raw);
    }
    r.muestras.push(muestra);
  }
  if (Object.keys(e.retailers).length) report.empresas.push(e);
}

const out = resolve(root, '_pruebas/diagnostico-fechas.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Listo: ${out}`);
await db.end();
