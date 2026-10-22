import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toText } from '../../sales-ingestion/adapters/parsers.js';
import type { CatalogAdapter } from './types.js';

/**
 * Catálogo de Hites Seller: "listaProducto" (CSV separado por ";").
 *
 *  - "codeSku" código del producto en Hites (10356000001001): clave única
 *  - "originSkuCode" SKU del vendedor (POLELIB1222)
 *  - "skuName" nombre: es el mismo "nombreProducto" que viene en las ventas de Hites
 *    (las ventas no traen un SKU utilizable, así que el cruce venta -> producto es por nombre)
 *  - "statusStoreSku" estado de la publicación en la tienda (PUBLICADO / PENDIENTE)
 *  - No trae precio ni stock.
 */
export const hitesCatalogAdapter: CatalogAdapter = {
  retailerCode: 'HITES',
  retailerName: 'Hites',

  requiredHeaders: ['codeSku', 'skuName', 'originSkuCode'],

  mapRow(row) {
    const retailerSku = toText(row['codeSku']);
    if (!retailerSku) throw new RowError('La fila no tiene "codeSku"');
    const name = toText(row['skuName'])?.replace(/\s+/g, ' ');
    if (!name) throw new RowError(`SKU ${retailerSku}: no tiene "skuName"`);

    return {
      retailerSku,
      sellerSku: toText(row['originSkuCode']) ?? toText(row['skuSellerPadre']),
      name,
      listPrice: null,
      offerPrice: null,
      offerFrom: null,
      offerTo: null,
      status: toText(row['statusStoreSku']),
      stock: null,
      imageUrl: null,
      raw: row,
    };
  },
};