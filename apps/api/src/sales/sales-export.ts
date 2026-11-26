import ExcelJS from 'exceljs';
import type { SaleWithMargin } from './sales.service.js';

const saleHeaders = {
  "orderLabel": "N° de orden",
  "orderNumber": "N° de orden interno",
  "retailer": "Retailer",
  "retailerCode": "Código del retailer",
  "orderDate": "Fecha de venta",
  "dispatchDeadline": "Fecha límite de despacho",
  "deliveredAt": "Fecha de entrega",
  "productName": "Producto",
  "retailName": "Producto en el retailer",
  "parentSku": "SKU padre",
  "state": "Estado",
  "status": "Estado del retailer",
  "statusRaw": "Estado original del retailer",
  "cancelled": "Cancelada",
  "source": "Origen",
  "sentToSupplier": "Enviada a proveedor",
  "customer": "Cliente",
  "customerRut": "RUT del cliente",
  "documentRequested": "Documento solicitado",
  "salePrice": "Precio del producto con IVA",
  "shippingPrice": "Envío pagado por el cliente",
  "saleTotal": "Total de venta con IVA",
  "cost": "Costo sin IVA",
  "costGross": "Costo con IVA",
  "costSource": "Origen del costo",
  "settlementCharges": "Cargos de liquidación",
  "settlementEstimated": "Liquidación estimada",
  "settlementNet": "Pago neto del retailer",
  "commission": "Comisión con IVA",
  "shippingCharges": "Cargos de envío con IVA",
  "supplierGross": "Factura proveedor con IVA",
  "supplierNet": "Factura proveedor sin IVA",
  "vatSale": "IVA de venta",
  "vatPurchase": "IVA de compra",
  "vatCommission": "IVA de comisión",
  "vatShipping": "IVA de envío",
  "vatToPay": "IVA a pagar (calculado)",
  "vat": "IVA a pagar (confirmado)",
  "utility": "Utilidad",
  "utilityEstimated": "Utilidad estimada",
  "total": "Total confirmado",
  "marginPct": "Margen",
  "key": "Clave de la venta"
} satisfies Record<Exclude<keyof SaleWithMargin, 'receipt'>, string>;

const receiptHeaders = {
  "number": "Folio de boleta o factura",
  "documentType": "Tipo de documento SII",
  "issuedAt": "Fecha de emisión",
  "totalGross": "Total del documento con IVA",
  "status": "Estado del documento",
  "creditNotes": "Monto de notas de crédito",
  "draftCreditNotes": "Notas de crédito en borrador",
  "retailStatus": "Estado de envío del documento",
  "retailMessage": "Mensaje de envío del documento",
  "id": "ID del documento"
} satisfies Record<keyof NonNullable<SaleWithMargin['receipt']>, string>;

export async function salesWorkbook(sales: SaleWithMargin[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Ventas', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [...Object.values(saleHeaders), ...Object.values(receiptHeaders)].map((header) => ({
    header,
    width: Math.max(16, header.length + 4),
  }));
  const saleKeys = Object.keys(saleHeaders) as (keyof typeof saleHeaders)[];
  const receiptKeys = Object.keys(receiptHeaders) as (keyof typeof receiptHeaders)[];
  for (const sale of sales) {
    sheet.addRow([
      ...saleKeys.map((key) => key === 'marginPct' && sale.marginPct !== null ? sale.marginPct / 100 : sale[key]),
      ...receiptKeys.map((key) => sale.receipt?.[key] ?? null),
    ]);
  }
  sheet.getColumn(saleKeys.indexOf('marginPct') + 1).numFmt = '0.00%';
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  return workbook.xlsx.writeBuffer();
}
