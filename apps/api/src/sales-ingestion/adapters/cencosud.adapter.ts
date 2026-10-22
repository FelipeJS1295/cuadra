import { toAmount, toDate, toText } from './parsers.js';
import { RowError, type MappedSale, type RawRow, type SalesAdapter } from './types.js';

/**
 * Adaptador del reporte de órdenes de Cencosud (Paris / Easy marketplace, export .xlsx).
 * Formato: 1 hoja, encabezados en la fila 1, una fila por unidad vendida.
 *
 * Ojo: no trae un ID único por fila. La clave es "Nro_orden|Sku_seller" y el
 * servicio la numera si se repite en el archivo (numberRepeatedLines).
 *
 * Ojo 2: "Comuna" viene dos veces: la 1ª es la de envío y la 2ª la de facturación,
 * que el lector renombra como "Comuna (2)".
 */
export const cencosudAdapter: SalesAdapter = {
  retailerCode: 'CENCOSUD',
  retailerName: 'Cencosud',
  numberRepeatedLines: true,

  requiredHeaders: [
    'Nro_orden',
    'Fecha_de_compra',
    'Nombre_Producto',
    'Precio pago cliente',
    'Sku_seller',
    'Estado',
  ],

  mapRow(row: RawRow): MappedSale {
    const orderNumber = toText(row['Nro_orden']);
    if (!orderNumber) throw new RowError('La fila no tiene "Nro_orden"');

    const sku = toText(row['Sku_seller']);

    try {
      return {
        externalItemId: `${orderNumber}|${sku ?? 'SIN-SKU'}`,

        sellerSku: sku,
        productName: toText(row['Nombre_Producto']),

        orderDate: toDate(row['Fecha_de_compra']),
        orderNumber,
        documentType: toText(row['Documento'])?.toUpperCase() ?? null,
        status: toText(row['Estado']),

        customerName: toText(row['Nombre_Cliente']),
        customerEmail: toText(row['Email_cliente'])?.toLowerCase() ?? null,
        customerDocument: toText(row['Número de documento'])?.toUpperCase() ?? null,
        shippingAddress: toText(row['Dirección de envío']),
        shippingCommune: toText(row['Comuna']),
        shippingRegion: toText(row['Region']),

        billingLegalName: toText(row['Razón social']),
        billingTaxId: toText(row['Rut'])?.toUpperCase() ?? null,
        billingActivity: toText(row['Giro']),
        billingAddress: toText(row['Dirección facturación']),

        unitPrice: toAmount(row['Precio']),
        paidPrice: toAmount(row['Precio pago cliente']),
        shippingCost: toAmount(row['Costo_despacho']),

        carrier: toText(row['OPL']),
        fulfillment: toText(row['Fulfillment']),
        dispatchDeadline: toDate(row['Fecha de entrega al courier']),

        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Orden ${orderNumber}: ${reason}`);
    }
  },
};