import type { NewSalesRecord } from '../../database/schema/index.js';

/** Una fila del Excel: { "Nombre de columna": valor } */
export type RawRow = Record<string, unknown>;

/** Venta ya normalizada, lista para guardar (sin id ni retailer, que pone el servicio) */
export type MappedSale = Omit<NewSalesRecord, 'id' | 'retailerId' | 'createdAt' | 'updatedAt'>;

/**
 * Un adaptador por retailer. Sabe leer el formato de ESE retailer
 * y convertir cada fila a los campos internos de sales_records.
 */
export interface SalesAdapter {
  /** Código del retailer en la tabla retailers. Ej: FALABELLA */
  retailerCode: string;
  /** Nombre comercial, para crearlo automáticamente si no existe */
  retailerName: string;
  /** Columnas que deben venir sí o sí en el archivo; si falta alguna, se rechaza */
  requiredHeaders: string[];
  /**
   * true si el archivo NO trae un ID único por fila (ej: Cencosud).
   * El servicio numera las filas repetidas: "orden|sku|1", "orden|sku|2"...
   */
  numberRepeatedLines?: boolean;
  /** Convierte una fila. Si la fila no sirve, lanza RowError con el motivo */
  mapRow(row: RawRow): MappedSale;
}

/** Error de una fila puntual: no detiene la carga, se informa al final */
export class RowError extends Error {}