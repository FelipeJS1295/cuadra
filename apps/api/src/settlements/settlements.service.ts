import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { readExcelTable } from '../common/excel-reader.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { retailers, settlementRecords } from '../database/schema/index.js';
import { RowError } from '../sales-ingestion/adapters/types.js';
import { cencosudFulfillmentSettlementAdapter } from './adapters/cencosud-fulfillment.settlement.js';
import { cencosudSettlementAdapter } from './adapters/cencosud.settlement.js';
import { falabellaSettlementAdapter } from './adapters/falabella.settlement.js';
import { hitesSettlementAdapter } from './adapters/hites.settlement.js';
import { walmartSettlementAdapter } from './adapters/walmart.settlement.js';
import type { SettlementAdapter } from './adapters/types.js';

/** Código de la opción: "CENCOSUD" o, si tiene modalidad, "CENCOSUD_FULFILLMENT" */
export const adapterCode = (a: SettlementAdapter) =>
  a.channel ? `${a.retailerCode}_${a.channel}` : a.retailerCode;

/** Nombre visible: "Cencosud" o "Cencosud Fulfillment" */
export const adapterName = (a: SettlementAdapter) =>
  a.channel ? `${a.retailerName} Fulfillment` : a.retailerName;

/** Adaptadores de liquidación disponibles. Un retailer nuevo se agrega aquí. */
const ADAPTER_LIST: SettlementAdapter[] = [
  falabellaSettlementAdapter,
  cencosudSettlementAdapter,
  cencosudFulfillmentSettlementAdapter,
  hitesSettlementAdapter,
  walmartSettlementAdapter,
];
const ADAPTERS: Record<string, SettlementAdapter> = Object.fromEntries(
  ADAPTER_LIST.map((a) => [adapterCode(a), a]),
);

const CHUNK_SIZE = 500;

export interface SettlementImportResult {
  retailer: string;
  fileName: string;
  totalRows: number;
  /** Movimientos nuevos */
  inserted: number;
  /** Movimientos que ya existían (se actualiza su estado de pago) */
  updated: number;
  errors: { row: number; message: string }[];
}

@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  availableRetailers() {
    return ADAPTER_LIST.map((a) => ({ code: adapterCode(a), name: adapterName(a) }));
  }

  /**
   * Carga un archivo de liquidación.
   * Si un movimiento ya existe (mismo retailer + clave), se actualizan sus datos de pago
   * (estado, estado de cuenta, referencia), porque el retailer los va completando
   * hasta el cierre del período. Nunca se duplica un movimiento.
   */
  async importFile(
    retailerCode: string,
    fileName: string,
    buffer: Buffer,
  ): Promise<SettlementImportResult> {
    const adapter = ADAPTERS[retailerCode.toUpperCase()];
    if (!adapter) {
      throw new BadRequestException(`No hay adaptador de liquidación para "${retailerCode}"`);
    }

    const { rows } = await readExcelTable(
      buffer,
      adapter.requiredHeaders,
      adapterName(adapter),
      fileName,
    );
    const retailerId = await this.getOrCreateRetailer(adapter);

    const errors: SettlementImportResult['errors'] = [];
    const records: (typeof settlementRecords.$inferInsert)[] = [];
    const repeats = new Map<string, number>();

    for (const { rowNumber, values } of rows) {
      try {
        const result = adapter.mapRow(values);
        for (const { lineKeyBase, ...mapped } of Array.isArray(result) ? result : [result]) {
          const n = (repeats.get(lineKeyBase) ?? 0) + 1;
          repeats.set(lineKeyBase, n);
          // La modalidad va en la clave para que nunca choque con la otra liquidación
          const prefix = adapter.channel ? `${adapter.channel}|` : '';
          records.push({
            ...mapped,
            retailerId,
            channel: adapter.channel ?? null,
            lineKey: `${prefix}${lineKeyBase}|${n}`,
          });
        }
      } catch (err) {
        if (!(err instanceof RowError)) throw err;
        errors.push({ row: rowNumber, message: err.message });
      }
    }

    let inserted = 0;
    let updated = 0;
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const result = await tx
          .insert(settlementRecords)
          .values(records.slice(i, i + CHUNK_SIZE))
          .onConflictDoUpdate({
            target: [settlementRecords.retailerId, settlementRecords.lineKey],
            set: {
              paymentStatus: sql`excluded.payment_status`,
              statementNumber: sql`excluded.statement_number`,
              paymentReference: sql`excluded.payment_reference`,
              taxDocumentNumber: sql`excluded.tax_document_number`,
              raw: sql`excluded.raw`,
              updatedAt: new Date(),
            },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        for (const r of result) r.inserted ? inserted++ : updated++;
      }
    });

    this.logger.log(
      `Liquidación ${adapterName(adapter)} "${fileName}": ${inserted} nuevos, ${updated} actualizados, ${errors.length} con error`,
    );

    return {
      retailer: adapterName(adapter),
      fileName,
      totalRows: rows.length,
      inserted,
      updated,
      errors,
    };
  }

  private async getOrCreateRetailer(adapter: SettlementAdapter): Promise<string> {
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