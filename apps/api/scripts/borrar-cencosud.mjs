/**
 * Borra las ventas y liquidaciones de Paris (Cencosud) de UNA empresa, para volver a traerlas limpias.
 *
 *   node apps/api/scripts/borrar-cencosud.mjs                    lista las empresas
 *   node apps/api/scripts/borrar-cencosud.mjs "Jerk Home"        muestra qué se borraría (no borra nada)
 *   node apps/api/scripts/borrar-cencosud.mjs "Jerk Home" --si   BORRA
 *
 * Borra: ventas de Cencosud/Paris (por API y por archivo), liquidaciones de Cencosud y las órdenes
 * guardadas de la API de Paris. NO borra boletas, facturas, notas de crédito ni facturas de proveedor:
 * quedan ligadas por N° de orden y vuelven a calzar cuando se traigan las ventas de nuevo.
 */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: resolve(root, '.env'), quiet: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const [name, flag] = process.argv.slice(2);
const tenants = (await db.query('select id, name from tenants order by name')).rows;
if (!name) {
  console.log('Empresas:\n' + tenants.map((t) => `  - ${t.name}`).join('\n'));
  console.log('\nUso: node apps/api/scripts/borrar-cencosud.mjs "Nombre empresa" [--si]');
  process.exit(0);
}
const tenant = tenants.find((t) => t.name.toLowerCase() === name.toLowerCase());
if (!tenant) {
  console.log(`No existe la empresa "${name}". Empresas: ${tenants.map((t) => t.name).join(', ')}`);
  process.exit(1);
}
const [ret] = (await db.query(`select id from retailers where tenant_id = $1 and code = 'CENCOSUD'`, [tenant.id])).rows;
if (!ret) {
  console.log(`${tenant.name} no tiene Paris/Cencosud`);
  process.exit(0);
}

const count = async (q, p) => Number((await db.query(q, p)).rows[0].n);
const resumen = {
  'líneas de venta': await count('select count(*) n from sales_records where retailer_id = $1', [ret.id]),
  'líneas de liquidación': await count('select count(*) n from settlement_records where retailer_id = $1', [ret.id]),
  'órdenes guardadas de la API': await count(`select count(*) n from retail_api_orders where tenant_id = $1 and provider = 'CENCOSUD'`, [tenant.id]),
};
const docs = await count('select count(*) n from customer_receipts where retailer_id = $1', [ret.id]);
console.log(`${tenant.name} · Paris/Cencosud`);
for (const [k, v] of Object.entries(resumen)) console.log(`  ${k}: ${v}`);
console.log(`  (se mantienen ${docs} boletas/facturas)`);

if (flag !== '--si') {
  console.log('\nNo se borró nada. Para borrar, agrega --si al final.');
  process.exit(0);
}

await db.query('begin');
try {
  await db.query('delete from sales_records where retailer_id = $1', [ret.id]);
  await db.query('delete from settlement_records where retailer_id = $1', [ret.id]);
  await db.query(`delete from retail_api_orders where tenant_id = $1 and provider = 'CENCOSUD'`, [tenant.id]);
  await db.query(
    `update retail_api_connections set last_orders_sync_at = null where tenant_id = $1 and provider = 'CENCOSUD'`,
    [tenant.id],
  );
  await db.query('commit');
  console.log('\nListo, borrado. Ahora: Conexiones → Paris → Traer ahora, y vuelve a subir la liquidación en Cobros.');
} catch (err) {
  await db.query('rollback');
  console.error('No se borró nada:', err.message);
  process.exit(1);
}
await db.end();
