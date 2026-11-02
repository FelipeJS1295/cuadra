import { arr, dayOf, num, pick, str } from './util.js';
import { ProviderError, type NormalizedSettlement, type Progress, type ProviderConfig } from './types.js';

type Call = (cfg: ProviderConfig, action: string, params?: Record<string, string>) => Promise<Record<string, unknown>>;
type Row = Record<string, unknown>;

/** "Nº de orden" / "Order No" / "order_no" -> "ndeorden" / "orderno" (para leer el campo sin importar cómo venga escrito) */
const norm = (k: string) =>
  k
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function field(row: Row, ...names: string[]): unknown {
  const keys = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const n of names) {
    const k = keys.get(norm(n));
    if (k !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return null;
}

/** Las filas vienen en algún arreglo dentro de SuccessResponse.Body (el nombre cambia según la versión) */
function rowsOf(body: Row): Row[] {
  const root = pick(body, 'SuccessResponse.Body');
  const found: Row[] = [];
  const walk = (v: unknown, depth: number) => {
    if (found.length || depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) found.push(...(v as Row[]));
      else for (const x of v) walk(x, depth + 1);
      return;
    }
    const values = Object.values(v as Row);
    // Un solo movimiento puede venir como objeto suelto (no arreglo)
    if (field(v as Row, 'Amount', 'Monto con IVA', 'Monto') !== null && field(v as Row, 'Transaction Type', 'Tipo de transacción', 'Fee Name') !== null) {
      found.push(v as Row);
      return;
    }
    for (const x of values) walk(x, depth + 1);
  };
  walk(root, 0);
  return found;
}

/** Clasifica el movimiento (nombres en español del reporte o en inglés de la API) */
function classify(type: string, category: string | null): NormalizedSettlement['kind'] {
  const t = type.toLowerCase();
  const c = (category ?? '').toLowerCase();
  if (t === 'pago por precio del producto' || t.includes('item price credit') || t === 'item price') return 'PRODUCT_PAYMENT';
  if (c === 'comisiones' || t.includes('comisión') || t.includes('comision') || t.includes('commission')) return 'COMMISSION';
  if (c.includes('cofinanciamiento') || t.includes('cofinanciamiento') || t.includes('fulfil') || t.includes('handling')) return 'LOGISTICS';
  if (c.includes('penal') || t.includes('penal') || t.includes('multa')) return 'PENALTY';
  if (c === 'a cargo de cliente' || t.includes('envío') || t.includes('envio') || t.includes('shipping') || t.includes('despacho')) return 'SHIPPING';
  return 'OTHER';
}

/** "17 May 2016", "2026-10-21", "21/10/2026" -> AAAA-MM-DD */
function day(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (/^\d{1,2} [A-Za-z]{3,} \d{4}$/.test(s)) {
    const d = new Date(`${s} 12:00 UTC`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return dayOf(s);
}

/** Falabella informa la comisión como fracción (0.2) o como % (20) */
function percent(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Math.abs(n) <= 1 ? Math.round(n * 10000) / 100 : n;
}

/**
 * Estado de cada liquidación (GetPayoutStatus): N° de estado de cuenta -> pagado o no.
 * Sirve para marcar los movimientos como "Pagado" cuando la fila no trae su estado.
 */
async function payouts(call: Call, cfg: ProviderConfig, from: string) {
  const since = new Date(`${from}T00:00:00-03:00`);
  since.setDate(since.getDate() - 45); // una liquidación puede incluir ventas de semanas anteriores
  const body = await call(cfg, 'GetPayoutStatus', { CreatedAfter: since.toISOString().replace(/\.\d{3}Z$/, '+00:00') });
  const out = new Map<string, boolean>();
  for (const s of arr<Row>(pick(body, 'SuccessResponse.Body.PayoutStatus', 'SuccessResponse.Body.PayoutStatus.Statement', 'SuccessResponse.Body.Statements'))) {
    const n = str(field(s, 'StatementNumber', 'Statement'));
    const paid = field(s, 'Paid');
    if (n) out.set(n, paid === true || paid === 1 || paid === '1' || String(paid).toLowerCase() === 'true');
  }
  return out;
}

/**
 * Movimientos de la liquidación de Falabella (GetTransactionDetails), de a 500.
 * La clave de cada movimiento es la misma que usa la carga por archivo ("Reporte de
 * Transacciones"), así lo que ya se subió por archivo se actualiza en vez de duplicarse.
 */
export async function falabellaSettlements(call: Call, cfg: ProviderConfig, from: string, to: string, progress: Progress): Promise<NormalizedSettlement[]> {
  const rows: Row[] = [];
  const limit = 500;
  for (let page = 0; page < 200; page++) {
    let body: Row;
    try {
      body = await call(cfg, 'GetTransactionDetails', {
        startTime: from,
        endTime: to,
        transType: '-1',
        limit: String(limit),
        offset: String(page * limit),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError(
        /action|acci[oó]n/i.test(msg)
          ? `Falabella no tiene habilitada la liquidación por API para tu cuenta (${msg}). Sigue cargándola con el archivo "Reporte de Transacciones".`
          : msg,
      );
    }
    const batch = rowsOf(body);
    rows.push(...batch);
    progress(`Falabella: ${rows.length} movimientos de la liquidación…`);
    if (batch.length < limit) break;
  }

  let paidByStatement = new Map<string, boolean>();
  if (rows.length) paidByStatement = await payouts(call, cfg, from).catch(() => new Map<string, boolean>());

  const repeats = new Map<string, number>();
  const out: NormalizedSettlement[] = [];
  for (const r of rows) {
    const type = str(field(r, 'Tipo de transacción', 'Transaction Type', 'TransactionType', 'Fee Name', 'FeeName'));
    const amount = num(field(r, 'Monto con IVA', 'Amount', 'Monto'));
    if (!type || amount === null) continue;
    const orderNumber = str(field(r, 'Nº de orden', 'Order No', 'OrderNo', 'Order Number', 'OrderNumber', 'Numero de orden'));
    const itemId = str(field(r, 'Id Artículo', 'Order Item No', 'OrderItemNo', 'OrderItemId', 'Order Item Id'));
    const date = day(field(r, 'Fecha de transacción', 'Transaction Date', 'TransactionDate', 'Fecha'));
    const category = str(field(r, 'Categoría de transacciones', 'Transaction Category', 'TransactionCategory', 'Category'));
    const statement = str(field(r, 'Nº estado de cuenta', 'Statement Number', 'StatementNumber', 'Statement'));
    // Manda el estado de la liquidación (GetPayoutStatus); si no aparece, el de la fila
    const paidRaw = str(field(r, 'Estado de pago', 'Paid Status', 'PaidStatus'));
    const paid =
      statement && paidByStatement.has(statement)
        ? paidByStatement.get(statement)
          ? 'Pagado'
          : 'Pendiente'
        : paidRaw && /^not paid$|^unpaid$/i.test(paidRaw)
          ? 'Pendiente'
          : paidRaw && /^paid$/i.test(paidRaw)
            ? 'Pagado'
            : paidRaw;

    // Misma clave que la carga por archivo: Id Artículo|tipo|fecha|monto|n
    const base = [itemId ?? orderNumber ?? 'SIN-ORDEN', type, date, String(amount)].join('|');
    const n = (repeats.get(base) ?? 0) + 1;
    repeats.set(base, n);

    out.push({
      lineKey: `${base}|${n}`,
      orderNumber,
      saleItemId: itemId,
      sellerSku: str(field(r, 'SKU vendedor', 'Seller SKU', 'SellerSku')),
      productName: str(field(r, 'Nombre del producto', 'Product Name', 'Details')),
      kind: classify(type, category),
      transactionType: type,
      transactionDate: date,
      amountGross: amount,
      commissionPct: percent(field(r, '% comisión', 'Commission Percentage', 'CommissionPercentage')),
      paymentStatus: paid,
      statementNumber: statement,
      raw: r,
    });
  }

  // Si llegaron filas pero ninguna se pudo leer, Falabella usa otros nombres: se avisa cuáles para ajustarlo
  if (rows.length && !out.length) {
    throw new ProviderError(
      `Falabella respondió ${rows.length} movimientos con un formato no reconocido. Campos: ${Object.keys(rows[0]).slice(0, 25).join(', ')}`,
    );
  }
  return out;
}
