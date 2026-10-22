import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readExcelTable } from '../common/excel-reader.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { retailers, salesRecords } from '../database/schema/index.js';
import { cencosudAdapter } from './adapters/cencosud.adapter.js';
import { falabellaAdapter } from './adapters/falabella.adapter.js';
import { hitesAdapter } from './adapters/hites.adapter.js';
import { walmartAdapter } from './adapters/walmart.adapter.js';
import { RowError, type MappedSale, type SalesAdapter } from './adapters/types.js';
import { deleteApiLinesOf } from '../retail-api/api-to-sales.js';

/** Adaptadores disponibles, por código de retailer. Un retailer nuevo se agrega aquí. */
const ADAPTERS: Record<string, SalesAdapter> = {
  [falabellaAdapter.retailerCode]: falabellaAdapter,
  [cencosudAdapter.retailerCode]: cencosudAdapter,
  [walmartAdapter.retailerCode]: walmartAdapter,
  [hitesAdapter.retailerCode]: hitesAdapter,
};

/** Cuántas filas se guardan por cada INSERT */
const CHUNK_SIZE = 500;

export interface ImportResult {
  retailer: string;
  fileName: string;
  /** Filas de datos en el archivo */
  totalRows: number;
  /** Filas nuevas guardadas */
  inserted: number;
  /** Filas omitidas porque su orden ya estaba en el sistema */
  skipped: number;
  /** Cuántas órdenes distintas se omitieron */
  skippedOrders: number;
  errors: { row: number; message: string }[];
}

@Injectable()
export class SalesIngestionService {
  private readonly logger = new Logger(SalesIngestionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Códigos de retailers que el sistema sabe leer */
  availableRetailers() {
    return Object.values(ADAPTERS).map((a) => ({ code: a.retailerCode, name: a.retailerName }));
  }

  /**
   * Lee un archivo (Excel o CSV) de un retailer y guarda sus ventas.
   * Regla: las órdenes que ya existen en el sistema se omiten completas;
   * las filas repetidas DENTRO del mismo archivo sí se cargan (son varias unidades).
   */
  async importFile(retailerCode: string, fileName: string, buffer: Buffer): Promise<ImportResult> {
    const adapter = ADAPTERS[retailerCode.toUpperCase()];
    if (!adapter) {
      throw new BadRequestException(`No hay adaptador para el retailer "${retailerCode}"`);
    }

    // 1 y 2. Leer el archivo (Excel o CSV) y verificar que sea el correcto:
    // si faltan columnas obligatorias, se rechaza indicando cuáles
    const { rows } = await readExcelTable(
      buffer,
      adapter.requiredHeaders,
      adapter.retailerName,
      fileName,
    );

    // 3. Convertir cada fila; las que fallan se informan sin detener la carga
    const errors: ImportResult['errors'] = [];
    const sales: MappedSale[] = [];
    const repeats = new Map<string, number>(); // para numerar líneas repetidas

    for (const { rowNumber, values } of rows) {
      try {
        const sale = adapter.mapRow(values);
        if (!sale.orderNumber) throw new RowError('La fila no tiene número de orden');

        if (adapter.numberRepeatedLines) {
          const n = (repeats.get(sale.externalItemId) ?? 0) + 1;
          repeats.set(sale.externalItemId, n);
          sale.externalItemId = `${sale.externalItemId}|${n}`;
        }
        sales.push(sale);
      } catch (err) {
        if (!(err instanceof RowError)) throw err;
        errors.push({ row: rowNumber, message: err.message });
      }
    }

    const retailerId = await this.getOrCreateRetailer(adapter);

    // 4. Separar las ventas de órdenes que YA existen en el sistema
    const existing = await this.existingOrders(
      retailerId,
      sales.map((s) => s.orderNumber!),
    );
    const toInsert = sales
      .filter((s) => !existing.has(s.orderNumber!))
      .map((s) => ({ ...s, retailerId }));
    // Órdenes que estaban solo por API: las reemplaza el archivo (trae más datos)
    const replaceApi = [...new Set(toInsert.map((s) => s.orderNumber!).concat(toInsert.map((s) => s.orderId).filter((x): x is string => Boolean(x))))];

    const skippedRows = sales.length - toInsert.length;
    const skippedOrders = new Set(sales.map((s) => s.orderNumber).filter((o) => existing.has(o!))).size;

    // 5. Guardar en una transacción: o se guarda completo, o nada
    let inserted = 0;
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < replaceApi.length; i += CHUNK_SIZE) await deleteApiLinesOf(tx, retailerId, replaceApi.slice(i, i + CHUNK_SIZE));
      for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const result = await tx
          .insert(salesRecords)
          .values(toInsert.slice(i, i + CHUNK_SIZE))
          .onConflictDoNothing() // red de seguridad: nunca duplica una línea
          .returning({ id: salesRecords.id });
        inserted += result.length;
      }
    });

    this.logger.log(
      `${adapter.retailerCode} "${fileName}": ${inserted} nuevas, ${skippedRows} omitidas ` +
        `(${skippedOrders} órdenes ya existían), ${errors.length} con error`,
    );

    return {
      retailer: adapter.retailerName,
      fileName,
      totalRows: rows.length,
      inserted,
      skipped: skippedRows + (toInsert.length - inserted),
      skippedOrders,
      errors,
    };
  }

  /** Números de orden de este retailer que ya están guardados */
  private async existingOrders(retailerId: string, orderNumbers: string[]) {
    const unique = [...new Set(orderNumbers)];
    const found = new Set<string>();

    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const rows = await this.db
        .selectDistinct({ orderNumber: salesRecords.orderNumber })
        .from(salesRecords)
        .where(
          and(
            eq(salesRecords.retailerId, retailerId),
            inArray(salesRecords.orderNumber, unique.slice(i, i + CHUNK_SIZE)),
            // Las líneas traídas por API no cuentan: el archivo las reemplaza
            sql`coalesce(${salesRecords.raw}->>'__origen', '') <> 'API'`,
          ),
        );
      rows.forEach((r) => r.orderNumber && found.add(r.orderNumber));
    }
    return found;
  }

  /** Busca el retailer por código; si no existe, lo crea con datos básicos */
  private async getOrCreateRetailer(adapter: SalesAdapter): Promise<string> {
    await this.db
      .insert(retailers)
      .values({ code: adapter.retailerCode, name: adapter.retailerName })
      .onConflictDoNothing({ target: [retailers.tenantId, retailers.code] });

    const [retailer] = await this.db
      .select({ id: retailers.id })
      .from(retailers)
      .where(eq(retailers.code, adapter.retailerCode));
    return retailer.id;
  }
}