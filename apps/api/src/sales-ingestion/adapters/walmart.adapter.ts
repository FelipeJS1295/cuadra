import { joinText, toAmount, toDate, toInteger, toText } from './parsers.js';
import { RowError, type MappedSale, type RawRow, type SalesAdapter } from './types.js';

/**
 * Adaptador del reporte de órdenes de Walmart (Seller Center, "PO Data" .xlsx).
 * Formato: 1 hoja, encabezados en la fila 1, una fila por línea de la orden de compra.
 *
 * Ojo: los montos vienen SIN IVA (Precio y Costo de envío netos, IVA en "Impuesto").
 * Se guardan tal cual y se marcan con amountsIncludeTax = false.
 */
export const walmartAdapter: SalesAdapter = {
  retailerCode: 'WALMART',
  retailerName: 'Walmart',

  requiredHeaders: [
    'Número de orden de compra',
    'Número de línea',
    'Fecha de orden',
    'Nombre del producto',
    'SKU',
    'Precio',
    'Estado',
  ],

  mapRow(row: RawRow): MappedSale {
    const po = toText(row['Número de orden de compra']);
    if (!po) throw new RowError('La fila no tiene "Número de orden de compra"');

    const line = toText(row['Número de línea']);
    if (!line) throw new RowError(`Orden ${po}: la fila no tiene "Número de línea"`);

    try {
      return {
        externalItemId: `${po}|${line}`,

        sellerSku: toText(row['SKU']),
        productName: toText(row['Nombre del producto']),
        quantity: toInteger(row['Cantidad']) ?? 1,

        orderDate: toDate(row['Fecha de orden']),
        orderNumber: po, // Número de orden de compra (PO)
        orderId: toText(row['Número De Orden']), // número que ve el cliente
        status: toText(row['Estado']),

        customerName: toText(row['Nombre del cliente']),
        shippingAddress: joinText(row['Enviar a la dirección 1'], row['Enviar a la dirección 2']),
        shippingCommune: toText(row['Ciudad']),
        shippingRegion: toText(row['Estado - Envío']),

        unitPrice: toAmount(row['Precio']),
        shippingCost: toAmount(row['Costo de envío']),
        taxAmount: toAmount(row['Impuesto']),
        commissionAmount: toAmount(row['Comisión']),
        discountAmount: toAmount(row['Descuento']),
        amountsIncludeTax: false,

        carrier: toText(row['Portador']),
        dispatchDeadline: toDate(row['Fecha Máxima de entrega a Courier']),

        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${po}: ${reason}`);
    }
  },
};