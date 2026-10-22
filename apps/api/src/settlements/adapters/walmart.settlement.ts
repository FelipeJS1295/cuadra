import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toText } from '../../sales-ingestion/adapters/parsers.js';
import { PENALTY_GROUP_KEY, type SettlementKind } from '../../database/schema/index.js';
import type { ExcelRow } from '../../common/excel-reader.js';
import type { MappedSettlement, SettlementAdapter } from './types.js';

/**
 * Adaptador de la liquidación de Walmart Marketplace (CSV separado por ",", en Windows-1252).
 * Formato: encabezados en la fila 1, una fila por movimiento.
 *
 *  - Concepto "SKU": venta o devolución del producto. "Afecto a Pago" es el precio CON IVA
 *    (159.990) y "Cargo por comision" la comisión ya con signo (−11.199 en venta, +11.199
 *    en devolución). Se separa en PRODUCT_PAYMENT y COMMISSION.
 *  - "Despacho seller" / "Despacho cliente": cobros de envío. "Logistica inversa": logística.
 *  - "No Afecto a Pago" es informativo (no se paga): no se suma.
 *  - Filas sin orden real (ej: "Disputa / Merma", orden "1") quedan como movimientos sin OC.
 *
 * Se cruza con las ventas por el número de orden del CLIENTE: "Orden / Purchase Order"
 * (3702630000576) = "Número De Orden" del reporte de ventas (no la PO P111867080).
 */
export const walmartSettlementAdapter: SettlementAdapter = {
  retailerCode: 'WALMART',
  retailerName: 'Walmart',

  requiredHeaders: [
    'Numero Liq. / Settlement number',
    'Concept / Concepto',
    'Orden / Purchase Order',
    'Afecto a Pago / Subject to Payment',
    'Cargo por comision / Commission Charges',
    'Estado / State',
  ],

  mapRow(row: ExcelRow): MappedSettlement[] {
    const concept = toText(row['Concept / Concepto']);
    if (!concept) throw new RowError('La fila no tiene "Concepto"');
    const rawOrder = toText(row['Orden / Purchase Order']);
    // Walmart usa "1" como orden en movimientos que no son de una venta (ej: merma)
    const order = rawOrder && rawOrder.length > 3 ? rawOrder : null;
    const type = toText(row['Tipo / Transaction Type']) ?? '';
    const item = toText(row['Item / Item']);

    try {
      const amount = Number(toAmount(row['Afecto a Pago / Subject to Payment']) ?? 0);
      const commission = Number(toAmount(row['Cargo por comision / Commission Charges']) ?? 0);
      const date = toDate(row['Fecha Estado / State Date']);
      const status = toText(row['Estado / State']);
      const isProduct = concept.toUpperCase() === 'SKU';
      const kind: SettlementKind = isProduct ? 'PRODUCT_PAYMENT' : classify(concept, type);

      const base = {
        orderNumber: order,
        saleItemId: kind === 'PENALTY' ? PENALTY_GROUP_KEY : order, // se cruza por orden
        sellerSku: isProduct ? toText(row['SKU / Product SKU']) : null,
        productName: isProduct ? toText(row['Nombre del Artículo / Partner Item Name']) : null,
        transactionCategory: type,
        transactionDate: date,
        paymentStatus: status,
        statementNumber: toText(row['Numero Liq. / Settlement number']),
        paymentReference: toText(row['Numero de devolucion / Return Number']),
        raw: row,
      };
      const key = [
        toText(row['Numero Liq. / Settlement number']),
        rawOrder,
        toText(row['Oms prime line number']),
        item,
        concept,
        status,
        date,
      ].join('|');

      if (isProduct) {
        return [
          {
            ...base,
            lineKeyBase: `${key}|PRODUCTO`,
            transactionType: `${amount < 0 ? 'Devolución' : 'Venta'}: ${base.productName ?? item ?? ''}`.trim(),
            kind: 'PRODUCT_PAYMENT',
            amountGross: amount.toFixed(2),
          },
          {
            ...base,
            lineKeyBase: `${key}|COMISION`,
            transactionType: `Comisión ${amount < 0 ? 'devolución' : 'venta'}`,
            kind: 'COMMISSION',
            amountGross: commission.toFixed(2), // ya viene con signo
            commissionPct: toAmount(row['% Comision / Commission Rate']),
          },
        ];
      }

      return [
        {
          ...base,
          lineKeyBase: `${key}|MOVIMIENTO`,
          transactionType: type && type !== 'Venta' ? `${type}: ${concept}` : concept,
          kind,
          amountGross: amount.toFixed(2),
        },
      ];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${rawOrder ?? '?'} (${concept}): ${reason}`);
    }
  },
};

function classify(concept: string, type: string): SettlementKind {
  const text = `${concept} ${type}`.toLowerCase();
  if (text.includes('multa')) return 'PENALTY';
  if (text.includes('logistica') || text.includes('logística')) return 'LOGISTICS';
  if (text.includes('despacho') || text.includes('envio') || text.includes('envío')) return 'SHIPPING';
  return 'OTHER';
}