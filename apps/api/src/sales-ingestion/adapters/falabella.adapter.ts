import { joinText, toAmount, toDate, toText } from './parsers.js';
import { RowError, type MappedSale, type RawRow, type SalesAdapter } from './types.js';

/**
 * RUT de la empresa para la factura. Falabella lo trae en dos columnas:
 * "N° documento para facturacion" (sin dígito) y "Digito verificador para facturacion".
 */
function falabellaTaxId(row: RawRow): string | null {
  const number = toText(row['N° documento para facturacion'])?.replace(/[.\s]/g, '').toUpperCase() ?? null;
  if (!number) return null;
  if (number.includes('-')) return number;
  const dv = toText(row['Digito verificador para facturacion'])?.toUpperCase();
  return dv ? `${number}-${dv}` : number;
}

/**
 * Adaptador del reporte de órdenes de Falabella (Seller Center, export .xlsx).
 * Formato: 1 hoja, encabezados en la fila 1, una fila por ítem vendido.
 */
export const falabellaAdapter: SalesAdapter = {
  retailerCode: 'FALABELLA',
  retailerName: 'Falabella',

  requiredHeaders: [
    'Item id',
    'SKU del vendedor',
    'Fecha de creacion',
    'N° orden',
    'Orden id',
    'Precio pagado',
    'Estado',
  ],

  mapRow(row: RawRow): MappedSale {
    const itemId = toText(row['Item id']);
    if (!itemId) throw new RowError('La fila no tiene "Item id"');

    // Datos de factura: solo si el cliente pidió factura
    const documentType = toText(row['Documento requerido'])?.toUpperCase() ?? null;
    const wantsInvoice =
      Boolean(documentType?.includes('FACTURA')) ||
      Boolean(toText(row['Tipo de documento para facturacion'])?.toUpperCase().includes('FACTURA'));

    try {
      return {
        externalItemId: itemId,

        sellerSku: toText(row['SKU del vendedor']),
        productName: toText(row['Producto']),

        orderDate: toDate(row['Fecha de creacion']),
        orderNumber: toText(row['N° orden']),
        orderId: toText(row['Orden id']),
        documentType,
        status: toText(row['Estado']),

        customerName: toText(row['Nombre del cliente']),
        customerEmail: toText(row['Email del cliente'])?.toLowerCase() ?? null,
        // RUT del cliente (ej: 20279218-9)
        customerDocument: toText(row['N° Documento del cliente'])?.toUpperCase() ?? null,
        shippingName: toText(row['Nombre de envio']),
        shippingAddress: joinText(
          row['Direccion de envio'],
          row['Direccion de envio 2'],
          row['Direccion de envio 3'],
        ),
        shippingCommune: toText(row['Comuna/Distrito/Localidad de envio']),
        shippingRegion: toText(row['Region/Departamento de envio']),

        ...(wantsInvoice
          ? {
              billingLegalName: toText(row['Nombre Legal para facturacion']) ?? toText(row['Nombre de facturacion']),
              billingTaxId: falabellaTaxId(row),
              billingActivity: toText(row['Actividad Economica para facturacion']),
              billingAddress: joinText(
                toText(row['Dirección para facturacion']) ??
                  joinText(row['Direccion de facturacion'], row['Direccion de facturacion 2'], row['Direccion de facturacion 3']),
                toText(row['Comuna/Distrito/Localidad para facturacion']) ??
                  toText(row['Comuna/Distrito/Localidad de facturacion']),
              ),
            }
          : {}),

        paidPrice: toAmount(row['Precio pagado']),
        unitPrice: toAmount(row['Precio unitario']),
        shippingCost: toAmount(row['Costo de envio']),

        carrier: toText(row['Operador Logistico']),
        trackingCode: toText(row['Codigo de seguimiento']),
        dispatchDeadline: toDate(row['Fecha limite de despacho']),

        raw: row,
      };
    } catch (err) {
      // Agrega el Item id al mensaje para encontrar la fila con problema
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`Item id ${itemId}: ${reason}`);
    }
  },
};