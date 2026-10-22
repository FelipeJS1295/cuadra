import type { ExcelRow } from '../../common/excel-reader.js';
import type { NewRetailerProduct } from '../../database/schema/index.js';

/** Producto del catálogo ya normalizado (sin id, retailer ni master, que pone el servicio) */
export type MappedCatalogItem = Pick<
  NewRetailerProduct,
  | 'retailerSku'
  | 'sellerSku'
  | 'name'
  | 'listPrice'
  | 'offerPrice'
  | 'offerFrom'
  | 'offerTo'
  | 'status'
  | 'stock'
  | 'imageUrl'
  | 'raw'
>;

/** Un adaptador por retailer: sabe leer el archivo de catálogo de ESE retailer */
export interface CatalogAdapter {
  retailerCode: string;
  retailerName: string;
  requiredHeaders: string[];
  /** Convierte una fila. Si la fila no sirve, lanza RowError con el motivo */
  mapRow(row: ExcelRow): MappedCatalogItem;
}