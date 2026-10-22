import { RowError } from '../../sales-ingestion/adapters/types.js';
import { toAmount, toDate, toInteger, toText } from '../../sales-ingestion/adapters/parsers.js';
import type { CatalogAdapter } from './types.js';

/** Columnas que se guardan como respaldo (el archivo trae ~420, con descripciones HTML largas) */
const RAW_COLUMNS = [
  'Falabella SKU',
  'Name',
  'Brand',
  'Model',
  'PrimaryCategory',
  'SellerSku',
  'ParentSku',
  'ProductId',
  'QuantityFalabella',
  'PriceFalabella',
  'SalePriceFalabella',
  'SaleStartDateFalabella',
  'SaleEndDateFalabella',
];

/**
 * Catálogo de Falabella Seller Center: exportación de productos ("Product_<categoría>_<fecha>.xlsx").
 *
 *  - "Falabella SKU" código de Falabella (141096181): clave única
 *  - "SellerSku" SKU del vendedor (SECAKIGRP): el mismo "SKU del vendedor" de las ventas
 *  - "PriceFalabella" precio normal y "SalePriceFalabella" precio oferta (con IVA),
 *    con "SaleStartDateFalabella" / "SaleEndDateFalabella" ("2026-10-05 00:00:00")
 *  - "QuantityFalabella" stock. No trae estado ni foto.
 */
export const falabellaCatalogAdapter: CatalogAdapter = {
  retailerCode: 'FALABELLA',
  retailerName: 'Falabella',

  requiredHeaders: ['Falabella SKU', 'Name', 'SellerSku', 'PriceFalabella'],

  mapRow(row) {
    const retailerSku = toText(row['Falabella SKU']);
    if (!retailerSku) throw new RowError('La fila no tiene "Falabella SKU"');
    const name = toText(row['Name'])?.replace(/\s+/g, ' ');
    if (!name) throw new RowError(`SKU ${retailerSku}: no tiene "Name"`);

    try {
      const offerPrice = toAmount(row['SalePriceFalabella']);
      return {
        retailerSku,
        sellerSku: toText(row['SellerSku']),
        name,
        listPrice: toAmount(row['PriceFalabella']),
        offerPrice,
        offerFrom: offerPrice ? toDate(row['SaleStartDateFalabella']) : null,
        offerTo: offerPrice ? toDate(row['SaleEndDateFalabella']) : null,
        status: null,
        stock: toInteger(row['QuantityFalabella']),
        imageUrl: null,
        raw: Object.fromEntries(RAW_COLUMNS.map((c) => [c, row[c] ?? null])),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RowError(`SKU ${retailerSku}: ${reason}`);
    }
  },
};