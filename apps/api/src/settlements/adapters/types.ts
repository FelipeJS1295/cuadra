import type { ExcelRow } from '../../common/excel-reader.js';
import type { NewSettlementRecord } from '../../database/schema/index.js';

/** Movimiento ya normalizado (sin id, retailer ni clave final, que pone el servicio) */
export type MappedSettlement = Omit<
  NewSettlementRecord,
  'id' | 'retailerId' | 'lineKey' | 'channel' | 'createdAt' | 'updatedAt'
> & {
  /** Base de la clave única; el servicio le agrega "|1", "|2" si se repite en el archivo */
  lineKeyBase: string;
};

/** Un adaptador por retailer para su archivo de liquidación / transacciones */
export interface SettlementAdapter {
  retailerCode: string;
  retailerName: string;
  /**
   * Modalidad que liquida este archivo, si el retailer tiene más de una
   * (ej: Cencosud "FULFILLMENT"). Aparece como opción aparte: "Cencosud Fulfillment".
   */
  channel?: 'FULFILLMENT';
  /** Columnas obligatorias; también sirven para encontrar la fila de encabezados */
  requiredHeaders: string[];
  /**
   * Convierte una fila del Excel. Puede devolver varios movimientos si la fila
   * mezcla conceptos (ej: Cencosud trae venta y comisión en la misma fila).
   */
  mapRow(row: ExcelRow): MappedSettlement | MappedSettlement[];
}