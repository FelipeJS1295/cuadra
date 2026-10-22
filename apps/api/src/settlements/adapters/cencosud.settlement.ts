import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toText } from '../../sales-ingestion/adapters/parsers.js';
import { PENALTY_GROUP_KEY, type SettlementKind } from '../../database/schema/index.js';
import type { ExcelRow } from '../../common/excel-reader.js';
import type { MappedSettlement, SettlementAdapter } from './types.js';

/** SKU genérico que Cencosud usa para movimientos de despacho */
const SHIPMENT_SKU = 'MK00000000-0';

/**
 * Adaptador del reporte de transacciones de Cencosud (Paris / Easy marketplace).
 * Formato: encabezados en la fila 1, una fila por transacción, con ID único ("id").
 *
 * A diferencia de Falabella, cada fila trae el monto Y su comisión juntos:
 *   monto 169.990 · comisión 16% = 27.198 · monto a pagar 142.792
 * Por eso una fila de venta se separa en 2 movimientos: PRODUCT_PAYMENT y COMMISSION.
 *
 * Se cruza con las ventas por ORDEN: "nro suborden" (3125727290) = "Nro_orden" del
 * reporte de ventas. Las ventas de Cencosud no traen un ID por línea.
 */
export const cencosudSettlementAdapter: SettlementAdapter = {
  retailerCode: 'CENCOSUD',
  retailerName: 'Cencosud',

  requiredHeaders: ['id', 'tipo', 'nro suborden', 'monto', 'Monto comisión', 'estado del pago'],

  mapRow(row: ExcelRow): MappedSettlement[] {
    const id = toText(row['id']);
    if (!id) throw new RowError('La fila no tiene "id"');
    const subOrder = toText(row['nro suborden']);
    const type = toText(row['tipo']) ?? '';
    const description = toText(row['descripción']);

    try {
      const sku = toText(row['sku']);
      const kind = classify(type, description);
      // Es venta/devolución de producto si trae SKU real y no es un cobro (multa, logística...)
      const isProduct =
        !!sku && sku !== SHIPMENT_SKU && !!toText(row['seller sku']) && kind === 'OTHER';
      const amount = Number(toAmount(row['monto']) ?? 0);
      const commission = Number(toAmount(row['Monto comisión']) ?? 0);
      const commissionTax = Number(toAmount(row['Monto IVA comisión']) ?? 0);

      // Datos comunes a todos los movimientos de esta fila
      const base = {
        orderNumber: subOrder,
        saleItemId: subOrder, // Cencosud se cruza por orden
        sellerSku: toText(row['seller sku']),
        productName: isProduct ? description : null,
        transactionCategory: type,
        transactionDate: toDate(row['fecha']),
        paymentStatus: toText(row['estado del pago']),
        statementNumber: toText(row['nro solicitud pago']),
        paymentReference: toText(row['nro solicitud factura']),
        taxDocumentNumber: toText(row['número factura']),
        raw: row,
      };

      if (isProduct) {
        // Venta (positiva) o devolución (negativa) del producto + su comisión
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
            amountGross: (-commission).toFixed(2), // la comisión se descuenta
            taxAmount: (-commissionTax).toFixed(2),
            commissionPct: Number(toAmount(row['comisión']) ?? 0).toFixed(2),
          },
        ];
      }

      // Despachos, cobros, multas y logística: un solo movimiento por lo que se paga/cobra
      return [
        {
          ...base,
          // Las multas se agrupan todas en una sola línea "Multa sin OC"
          ...(kind === 'PENALTY' ? { saleItemId: PENALTY_GROUP_KEY } : {}),
          lineKeyBase: `${id}|MOVIMIENTO`,
          transactionType: description && description !== type ? `${type}: ${description}` : type,
          kind,
          amountGross: (amount - commission).toFixed(2),
        },
      ];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Transacción ${id} (orden ${subOrder ?? '?'}): ${reason}`);
    }
  },
};

function classify(type: string, description: string | null): SettlementKind {
  const text = `${type} ${description ?? ''}`.toLowerCase();
  if (text.includes('multa')) return 'PENALTY';
  if (text.includes('logística') || text.includes('logistica')) return 'LOGISTICS';
  if (text.includes('despacho') || text.includes('shipment')) return 'SHIPPING';
  return 'OTHER';
}