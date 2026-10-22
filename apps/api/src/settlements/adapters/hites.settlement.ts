import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { ExcelRow } from '../../common/excel-reader.js';
import type { MappedSettlement, SettlementAdapter } from './types.js';

/**
 * Adaptador del "Detalle período" de Hites Seller (liquidación).
 * Formato: encabezados en la fila 1, una fila por orden de compra.
 *
 * Cada fila trae el resumen de la orden:
 *   TOTAL 220.980 (producto 189.990 + envío 30.990)
 *   COMISIÓN 37.998 (20% del producto) · SHIPPING 30.990 (lo retiene Hites)
 *   PAGO 151.992 = TOTAL − COMISIÓN − SHIPPING
 * Se separa en: pago del producto (TOTAL − SHIPPING) y comisión. Si el PAGO informado
 * no cuadra con eso, la diferencia queda como "otros cargos" para que el neto siempre
 * sea exactamente lo que pagó Hites.
 *
 * Se cruza con las ventas por ORDEN ("ORDEN DE COMPRA" = "orderNumber" de ventas).
 */
export const hitesSettlementAdapter: SettlementAdapter = {
  retailerCode: 'HITES',
  retailerName: 'Hites',

  requiredHeaders: ['ORDEN DE COMPRA', 'TIPO', 'TOTAL', 'COMISIÓN', 'SHIPPING', 'PAGO'],

  mapRow(row: ExcelRow): MappedSettlement[] {
    const order = toText(row['ORDEN DE COMPRA']);
    if (!order) throw new RowError('La fila no tiene "ORDEN DE COMPRA"');
    const type = toText(row['TIPO']) ?? 'INGRESO';

    try {
      // Devoluciones / egresos: si vienen en positivo, se dejan en negativo
      const isReversal = /devol|egreso|revers|reembol/i.test(type);
      const sign = (n: number) => (isReversal && n > 0 ? -n : n);

      const total = sign(Number(toAmount(row['TOTAL']) ?? 0));
      const shipping = sign(Number(toAmount(row['SHIPPING']) ?? 0));
      const commission = sign(Number(toAmount(row['COMISIÓN']) ?? 0));
      const payment = sign(Number(toAmount(row['PAGO']) ?? 0));

      const product = total - shipping;
      const difference = payment - (product - commission);

      const base = {
        orderNumber: order,
        saleItemId: order, // Hites se cruza por orden
        transactionCategory: type,
        paymentStatus: toText(row['ESTADO']),
        raw: row,
      };
      const key = [order, type, total, payment].join('|');

      const movements: MappedSettlement[] = [
        {
          ...base,
          lineKeyBase: `${key}|PRODUCTO`,
          transactionType: `${type}: pago del producto`,
          kind: 'PRODUCT_PAYMENT',
          amountGross: product.toFixed(2),
        },
        {
          ...base,
          lineKeyBase: `${key}|COMISION`,
          transactionType: `${type}: comisión`,
          kind: 'COMMISSION',
          amountGross: (-commission).toFixed(2),
          commissionPct: product !== 0 ? ((commission / product) * 100).toFixed(2) : null,
        },
      ];

      if (Math.abs(difference) >= 1) {
        movements.push({
          ...base,
          lineKeyBase: `${key}|AJUSTE`,
          transactionType: `${type}: diferencia entre PAGO y TOTAL − COMISIÓN − SHIPPING`,
          kind: 'OTHER',
          amountGross: difference.toFixed(2),
        });
      }
      return movements;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${order}: ${reason}`);
    }
  },
};