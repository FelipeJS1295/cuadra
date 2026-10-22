import { joinText, toAmount, toDate, toInteger, toText } from './parsers.js';
import { RowError, type MappedSale, type RawRow, type SalesAdapter } from './types.js';

/**
 * Adaptador del reporte "Detalle Órdenes de Compra" de Hites Seller (CSV separado por ";").
 * Formato: encabezados en la fila 1, una fila por línea, con ID único ("id").
 *
 * Ojo:
 *  - Los montos son el TOTAL de la línea (con IVA): si cantidad = 2, el precio es por 2.
 *    Se guarda el precio POR UNIDAD (total ÷ cantidad) para comparar igual que otros retailers.
 *  - "skuSeller" viene como "NO APLICA" y "skuHites" es igual para todos los productos:
 *    no sirven para identificar el producto. Se guarda solo el nombre.
 *  - "fechaVenta" viene como 20261006; se usa "fechaCreacion" (2026-10-06T19:22:27).
 */
export const hitesAdapter: SalesAdapter = {
  retailerCode: 'HITES',
  retailerName: 'Hites',

  requiredHeaders: [
    'id',
    'orderNumber',
    'fechaCreacion',
    'nombreProducto',
    'cantidad',
    'totalProductGrossPrice',
    'estado',
  ],

  mapRow(row: RawRow): MappedSale {
    const id = toText(row['id']);
    if (!id) throw new RowError('La fila no tiene "id"');
    const orderNumber = toText(row['orderNumber']);

    try {
      const quantity = toInteger(row['cantidad']) ?? 1;
      if (quantity <= 0) throw new Error(`Cantidad inválida: ${quantity}`);

      // Total de la línea -> precio por unidad
      const perUnit = (column: string) => {
        const total = toAmount(row[column]);
        return total === null ? null : (Number(total) / quantity).toFixed(2);
      };

      return {
        externalItemId: id,

        sellerSku: null, // Hites no informa un SKU utilizable
        productName: toText(row['nombreProducto']),
        quantity,

        orderDate: toDate(row['fechaCreacion']),
        orderNumber,
        orderId: toText(row['orderFather']),
        status: toText(row['estado']),

        customerName: toText(row['customerName']),
        customerEmail: toText(row['correoCliente'])?.toLowerCase() ?? null,
        shippingAddress: joinText(row['calle'], row['numero'], row['observaciones']),
        shippingCommune: toText(row['comuna']),
        shippingRegion: toText(row['region']),

        unitPrice: perUnit('totalProductGrossPrice'),
        paidPrice: perUnit('totalProductGrossPrice'),
        taxAmount: toAmount(row['totalProductTaxPrice']), // IVA total de la línea
        shippingCost: toAmount(row['grossShippingTotal']),
        amountsIncludeTax: true,

        carrier: toText(row['logisticsIntegratorName']),
        dispatchDeadline: toDate(row['pickingDate']),

        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${orderNumber ?? id}: ${reason}`);
    }
  },
};