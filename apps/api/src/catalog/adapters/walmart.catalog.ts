import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toInteger, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { CatalogAdapter } from './types.js';

/**
 * Catálogo de Walmart Marketplace: "items_list" (CSV en UTF-8 con BOM, separado por ",").
 *
 *  - Walmart no trae un código propio del producto: el "SKU" es el del vendedor
 *    (NWALFLNEG), el mismo que viene en el reporte de ventas. Se usa como clave y como SKU seller.
 *  - "Price (CLP)" precio publicado (con IVA). No trae precio oferta.
 *  - "Estado" (PUBLISHED...), "Inventario" (stock) e "Imagen" (URL de la foto).
 */
export const walmartCatalogAdapter: CatalogAdapter = {
  retailerCode: 'WALMART',
  retailerName: 'Walmart',

  requiredHeaders: ['Nombre del producto', 'SKU', 'Price (CLP)'],

  mapRow(row) {
    const sku = toText(row['SKU']);
    if (!sku) throw new RowError('La fila no tiene "SKU"');
    const name = toText(row['Nombre del producto'])?.replace(/\s+/g, ' ');
    if (!name) throw new RowError(`SKU ${sku}: no tiene "Nombre del producto"`);

    try {
      return {
        retailerSku: sku,
        sellerSku: sku,
        name,
        listPrice: toAmount(row['Price (CLP)']),
        offerPrice: null,
        offerFrom: null,
        offerTo: null,
        status: toText(row['Estado']),
        stock: toInteger(row['Inventario']),
        imageUrl: toText(row['Imagen']),
        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`SKU ${sku}: ${reason}`);
    }
  },
};