import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { ExcelRow } from '../../common/excel-reader.js';
import type { MappedSettlement, SettlementAdapter } from './types.js';

/**
 * Adaptador del reporte de transacciones de Cencosud FULFILLMENT
 * (Cencosud almacena y despacha desde su bodega).
 *
 * Distinto al de despacho propio: no trae "Monto comisión" ni "estado del pago".
 * La comisión se calcula como monto − monto a pagar (169.990 − 142.792 = 27.198).
 * El "descuento comercial" lo asume Cencosud: no cambia el monto a pagar.
 * Se cruza con las ventas por ORDEN ("nro suborden" = "Nro_orden" de ventas).
 */
export const cencosudFulfillmentSettlementAdapter: SettlementAdapter = {
  retailerCode: 'CENCOSUD',
  retailerName: 'Cencosud',
  channel: 'FULFILLMENT',

  requiredHeaders: ['id', 'tipo', 'nro suborden', 'monto', 'monto a pagar', 'monto liq.factura'],

  mapRow(row: ExcelRow): MappedSettlement[] {
    const id = toText(row['id']);
    if (!id) throw new RowError('La fila no tiene "id"');
    const subOrder = toText(row['nro suborden']);
    const type = toText(row['tipo']) ?? '';
    const description = toText(row['descripcion']);

    try {
      const amount = Number(toAmount(row['monto']) ?? 0);
      const toPay = Number(toAmount(row['monto a pagar']) ?? 0);

      const base = {
        orderNumber: subOrder,
        saleItemId: subOrder, // se cruza por orden
        sellerSku: toText(row['seller sku']),
        productName: description,
        transactionCategory: type,
        transactionDate: toDate(row['fecha']),
        paymentStatus: toText(row['estado de liq.factura']),
        statementNumber: toText(row['nro solicitud liq.factura']),
        taxDocumentNumber: toText(row['número liq.factura']),
        raw: row,
      };

      // Venta (o devolución, con montos negativos) + su comisión
      return [
        {
          ...base,
          lineKeyBase: `${id}|PRODUCTO`,
          transactionType: `${type}: ${description ?? ''}`.trim(),
          kind: 'PRODUCT_PAYMENT',
          amountGross: amount.toFixed(2),
        },
        {
          ...base,
          lineKeyBase: `${id}|COMISION`,
          transactionType: `Comisión ${type.toLowerCase()}`,
          kind: 'COMMISSION',
          amountGross: (toPay - amount).toFixed(2), // negativa: lo que Cencosud se queda
          commissionPct: Number(toAmount(row['comisión']) ?? 0).toFixed(2),
        },
      ];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Transacción ${id} (orden ${subOrder ?? '?'}): ${reason}`);
    }
  },
};