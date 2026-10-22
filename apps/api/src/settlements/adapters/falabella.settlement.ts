import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { SettlementKind } from '../../database/schema/index.js';
import type { ExcelRow } from '../../common/excel-reader.js';
import type { MappedSettlement, SettlementAdapter } from './types.js';

/**
 * Adaptador del "Reporte de Transacciones" de Falabella Seller Center.
 * Formato: encabezados en la fila 6 (arriba vienen fecha y avisos; el lector los salta),
 * una fila por movimiento de dinero (pago, comisión, envío, cofinanciamiento...).
 * Se cruza con la venta por "Id Artículo" (= "Item id" del reporte de órdenes).
 */
export const falabellaSettlementAdapter: SettlementAdapter = {
  retailerCode: 'FALABELLA',
  retailerName: 'Falabella',

  requiredHeaders: [
    'Nº de orden',
    'Id Artículo',
    'Tipo de transacción',
    'Fecha de transacción',
    'Monto con IVA',
  ],

  mapRow(row: ExcelRow): MappedSettlement {
    const orderNumber = toText(row['Nº de orden']);
    const itemId = toText(row['Id Artículo']);
    const type = toText(row['Tipo de transacción']);
    if (!type) throw new RowError('La fila no tiene "Tipo de transacción"');

    try {
      const transactionDate = toDate(row['Fecha de transacción']);
      const amountGross = toAmount(row['Monto con IVA']);
      const category = toText(row['Categoría de transacciones']);

      return {
        lineKeyBase: [itemId ?? orderNumber ?? 'SIN-ORDEN', type, transactionDate, amountGross].join('|'),

        orderNumber,
        saleItemId: itemId,
        sellerSku: toText(row['SKU vendedor']),
        productName: toText(row['Nombre del producto']),

        transactionType: type,
        transactionCategory: category,
        kind: classify(type, category),
        transactionDate,

        amountNet: toAmount(row['Monto (Sin IVA)']),
        taxAmount: toAmount(row['IVA']),
        amountGross,
        commissionPct: toPercent(row['% comisión']),

        paymentStatus: toText(row['Estado de pago']),
        statementNumber: toText(row['Nº estado de cuenta']),
        paymentReference: toText(row['Referencia de pago Fpay']),
        taxDocumentNumber: cleanNA(row['N° Documento Tributario']),

        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${orderNumber ?? '?'} (${type}): ${reason}`);
    }
  },
};

/** Clasifica el movimiento de Falabella en un tipo normalizado */
function classify(type: string, category: string | null): SettlementKind {
  const t = type.toLowerCase();
  const c = (category ?? '').toLowerCase();
  if (t === 'pago por precio del producto') return 'PRODUCT_PAYMENT';
  if (c === 'comisiones' || t.includes('comisión por venta')) return 'COMMISSION';
  if (c.includes('cofinanciamiento') || t.includes('cofinanciamiento')) return 'LOGISTICS';
  if (c === 'a cargo de cliente' || t.includes('envío')) return 'SHIPPING';
  return 'OTHER';
}

/** Falabella informa la comisión como fracción (0.2) -> se guarda como % (20.00) */
function toPercent(value: unknown): string | null {
  const amount = toAmount(value);
  if (amount === null) return null;
  const n = Number(amount);
  return (n <= 1 ? n * 100 : n).toFixed(2);
}

/** "n/a" -> null */
function cleanNA(value: unknown): string | null {
  const text = toText(value);
  return text && text.toLowerCase() !== 'n/a' ? text : null;
}