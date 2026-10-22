import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { CatalogAdapter } from './types.js';

/**
 * Catálogo de Cencosud (Paris): exportación de precios del portal ("export-price").
 * La tabla viene en la hoja "marketplace" (las otras hojas son de configuración).
 *
 *  - "SKU(*)"      SKU de Paris (MK8400CF1K): clave única
 *  - "SELLER SKU"  SKU del vendedor (SECRICHFBNGCL): el mismo "Sku_seller" de las ventas
 *  - "Precio(*)" / "Precio oferta" con IVA; "Fecha desde" / "Fecha hasta" de la oferta
 *    (vienen 3 veces; se usan las primeras, que son las de "Precio oferta")
 */
export const cencosudCatalogAdapter: CatalogAdapter = {
  retailerCode: 'CENCOSUD',
  retailerName: 'Cencosud',

  requiredHeaders: ['SKU(*)', 'SELLER SKU', 'NOMBRE', 'Precio(*)'],

  mapRow(row) {
    const retailerSku = toText(row['SKU(*)']);
    if (!retailerSku) throw new RowError('La fila no tiene "SKU(*)"');
    const name = toText(row['NOMBRE'])?.replace(/\s+/g, ' ');
    if (!name) throw new RowError(`SKU ${retailerSku}: no tiene "NOMBRE"`);

    try {
      const offerPrice = toAmount(row['Precio oferta']);
      return {
        retailerSku,
        sellerSku: toText(row['SELLER SKU']),
        name,
        listPrice: toAmount(row['Precio(*)']),
        offerPrice,
        offerFrom: offerPrice ? toDate(row['Fecha desde']) : null,
        offerTo: offerPrice ? toDate(row['Fecha hasta']) : null,
        status: null,
        stock: null,
        imageUrl: null,
        raw: row,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`SKU ${retailerSku}: ${reason}`);
    }
  },
};