/**
 * Datos de demostración: crea la empresa "Muebles Demo SpA" con ventas, liquidaciones,
 * boletas y facturas de proveedor de los últimos 2 meses, y el usuario:
 *   demo@cuadra.local / demo12345
 *
 * Uso (desde la raíz):  pnpm seed:demo
 * Si la empresa demo ya existe, la borra y la crea de nuevo.
 */
import { config } from 'dotenv';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

config({ path: '../../.env' });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const EMAIL = 'demo@cuadra.local';
const PASSWORD = 'demo12345';

// Misma forma de cifrar contraseñas que la API (scrypt)
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await promisify(scrypt)(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Generador pseudoaleatorio con semilla (los datos salen iguales cada vez)
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const dayStr = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const net = (gross) => Math.round(gross / 1.19);

function dv(body) {
  let sum = 0, f = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += Number(body[i]) * f; f = f === 7 ? 2 : f + 1; }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
const rut = (n) => `${n}-${dv(String(n))}`;

const PRODUCTS = [
  { sku: 'SOF-RICHTER', name: 'Sofá Seccional Richter', cost: 165000, price: 349990 },
  { sku: 'POL-ELIZA', name: 'Poltrona Eliza', cost: 52000, price: 119990 },
  { sku: 'SOF-TORINO', name: 'Sofá Torino 3 cuerpos', cost: 120000, price: 259990 },
  { sku: 'BER-NIDO', name: 'Bergère Nido', cost: 61000, price: 139990 },
  { sku: 'PUF-ROMA', name: 'Pouf Roma', cost: 0, price: 39990 },
];
const COLORS = ['Gris', 'Beige', 'Azul'];
const NAMES = ['Camila Rojas', 'Diego Muñoz', 'Valentina Soto', 'Matías Pérez', 'Francisca Díaz', 'Benjamín Silva', 'Josefa Morales', 'Tomás Herrera'];
const COMMUNES = ['Providencia', 'Ñuñoa', 'Maipú', 'La Florida', 'Viña del Mar', 'Concepción', 'Puente Alto'];

try {
  await db.query('begin');
  const old = await db.query(`select id from tenants where name = 'Muebles Demo SpA'`);
  for (const t of old.rows) await db.query('delete from tenants where id = $1', [t.id]);

  let user = (await db.query('select id from users where email = $1', [EMAIL])).rows[0];
  if (!user) {
    user = (await db.query(`insert into users (email, name, password_hash) values ($1, 'Demo', $2) returning id`, [EMAIL, await hashPassword(PASSWORD)])).rows[0];
  }
  const tenant = (
    await db.query(
      `insert into tenants (name, legal_name, tax_id, plan, trial_ends_at, onboarding)
       values ('Muebles Demo SpA', 'Muebles Demo SpA', $1, 'PRO', current_date + 14, '{"sii":"SALTADO"}') returning id`,
      [rut(76543210)],
    )
  ).rows[0];
  await db.query(`insert into memberships (user_id, tenant_id, role) values ($1, $2, 'DUENO')`, [user.id, tenant.id]);

  // Desde aquí, todo dentro de la empresa (igual que la API: rol con RLS + tenant)
  await db.query('set local role cuadra_app');
  await db.query(`select set_config('app.tenant_id', $1, true)`, [tenant.id]);

  const retailers = {};
  for (const [code, name, pct, days] of [['FALABELLA', 'Falabella', 15, 30], ['CENCOSUD', 'Paris', 18, 45], ['WALMART', 'Walmart', 16, 30], ['HITES', 'Hites', 20, 30]]) {
    retailers[code] = (await db.query(`insert into retailers (code, name, commission_pct, payment_days) values ($1, $2, $3, $4) returning id`, [code, name, pct, days])).rows[0].id;
  }

  const masters = {};
  for (const p of PRODUCTS) {
    masters[p.sku] = (await db.query(`insert into products (sku_master, name, provisional_cost) values ($1, $2, $3) returning id`, [p.sku, p.name, p.cost])).rows[0].id;
    for (const code of ['FALABELLA', 'CENCOSUD', 'WALMART']) {
      for (const color of COLORS) {
        const sellerSku = `${p.sku}-${color.slice(0, 3).toUpperCase()}`;
        await db.query(
          `insert into retailer_products (retailer_id, retailer_sku, seller_sku, name, list_price, product_id, status) values ($1, $2, $3, $4, $5, $6, 'MANUAL')`,
          [retailers[code], `${code.slice(0, 2)}${sellerSku}`, sellerSku, `${p.name} ${color}`, p.price, masters[p.sku]],
        );
      }
    }
  }

  const supplier = (await db.query(`insert into suppliers (name, tax_id) values ('Fábrica de Muebles del Sur', $1) returning id`, [rut(77111222)])).rows[0].id;
  const invoices = new Map(); // N° factura -> id

  let orderSeq = 3254000000;
  let receiptSeq = 1000;
  let lineSeq = 0;
  const orders = [];
  for (let i = 0; i < 70; i++) {
    const code = pick(['FALABELLA', 'FALABELLA', 'CENCOSUD', 'CENCOSUD', 'WALMART']);
    const p = pick(PRODUCTS);
    const color = pick(COLORS);
    const age = Math.floor(rand() * 55);
    const date = daysAgo(age);
    const cancelled = rand() < 0.06;
    const price = Math.round(p.price * (rand() < 0.3 ? 0.9 : 1));
    const orderNumber = code === 'CENCOSUD' ? `ecl${18700000 + i}-01` : code === 'WALMART' ? `P10${8900000 + i}` : String(orderSeq++);
    const orderId = code === 'WALMART' ? String(8592665000000 + i) : null;
    const itemId = `ITEM-${100000 + i}`;
    orders.push({ code, p, color, age, date, cancelled, price, orderNumber, orderId, itemId });
    const walmart = code === 'WALMART';
    await db.query(
      `insert into sales_records (retailer_id, external_item_id, seller_sku, product_name, order_date, order_number, order_id, document_type, status,
         customer_name, customer_document, shipping_address, shipping_commune, shipping_region, paid_price, unit_price, amounts_include_tax, quantity, dispatch_deadline)
       values ($1,$2,$3,$4,$5,$6,$7,'BOLETA',$8,$9,$10,$11,$12,'RM',$13,$13,$14,1,$15)`,
      [
        retailers[code], itemId, `${p.sku}-${color.slice(0, 3).toUpperCase()}`, `${p.name} ${color}`, dayStr(date), orderNumber, orderId,
        cancelled ? 'Cancelada' : age > 7 ? 'Entregada' : 'Listo para enviar', pick(NAMES), rut(10000000 + Math.floor(rand() * 9000000)),
        `Av. Demo ${100 + i}`, pick(COMMUNES), walmart ? net(price) : price, !walmart, dayStr(daysAgo(age - 3)),
      ],
    );
  }

  for (const o of orders) {
    const matchKey = o.code === 'FALABELLA' ? o.itemId : o.code === 'WALMART' ? o.orderId : o.orderNumber;
    // Boleta: casi todas las ventas (las más nuevas pueden faltar)
    if ((!o.cancelled || rand() < 0.5) && (o.age > 4 || rand() < 0.5)) {
      await db.query(
        `insert into customer_receipts (retailer_id, order_number, receipt_number, total_gross, document_type, status, issued_at) values ($1,$2,$3,$4,39,'REGISTRADA',$5)`,
        [retailers[o.code], o.orderNumber, String(receiptSeq++), o.price, dayStr(o.date)],
      );
    }
    if (o.cancelled) continue;
    // Liquidación: ventas de hace más de 20 días (el retailer paga después)
    if (o.age > 20) {
      const pct = { FALABELLA: 15, CENCOSUD: 18, WALMART: 16 }[o.code];
      const commission = -Math.round(o.price * pct / 100);
      const statement = `EC-${dayStr(daysAgo(o.age - 15)).slice(0, 7)}`;
      for (const [kind, amount] of [['PRODUCT_PAYMENT', o.price], ['COMMISSION', commission], ...(rand() < 0.3 ? [['SHIPPING', -4990]] : [])]) {
        await db.query(
          `insert into settlement_records (retailer_id, line_key, order_number, sale_item_id, seller_sku, product_name, kind, transaction_date, amount_net, tax_amount, amount_gross, commission_pct, payment_status, statement_number)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Pagado',$13)`,
          [retailers[o.code], `L${lineSeq++}`, o.orderId ?? o.orderNumber, matchKey, `${o.p.sku}`, o.p.name, kind, dayStr(daysAgo(o.age - 15)),
            net(amount), amount - net(amount), amount, kind === 'COMMISSION' ? pct : null, statement],
        );
      }
    }
    // Factura del proveedor: la mayoría de las ventas de hace más de 10 días
    if (o.age > 10 && rand() < 0.8 && o.p.cost > 0) {
      const number = String(5500 + Math.floor(o.age / 7));
      if (!invoices.has(number)) {
        invoices.set(number, (await db.query(`insert into purchase_documents (supplier_id, document_number, issue_date) values ($1,$2,$3) returning id`, [supplier, number, dayStr(daysAgo(Math.floor(o.age / 7) * 7))])).rows[0].id);
      }
      await db.query(
        `insert into purchase_document_lines (document_id, retailer_id, item_key, order_number, product_name, amount_net) values ($1,$2,$3,$4,$5,$6)`,
        [invoices.get(number), retailers[o.code], matchKey, o.orderNumber, `${o.p.name} ${o.color}`, o.p.cost],
      );
    }
  }
  // Algunas facturas ya pagadas
  let n = 0;
  for (const id of invoices.values()) {
    if (n++ % 2) continue;
    await db.query(`insert into purchase_document_payments (document_id, amount, paid_at, method) select $1, round(sum(amount_net) * 1.19), current_date - 5, 'Transferencia' from purchase_document_lines where document_id = $1`, [id]);
  }
  await db.query('commit');
  console.log(`Empresa demo creada con ${orders.length} ventas.`);
  console.log(`Entra con: ${EMAIL} / ${PASSWORD}`);
} catch (err) {
  await db.query('rollback');
  console.error('No se pudo crear la demo:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
