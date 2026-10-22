import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { readExcelTable } from '../common/excel-reader.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { products, retailerProducts, retailers } from '../database/schema/index.js';
import { RowError } from '../sales-ingestion/adapters/types.js';
import { cencosudCatalogAdapter } from './adapters/cencosud.catalog.js';
import { walmartCatalogAdapter } from './adapters/walmart.catalog.js';
import { falabellaCatalogAdapter } from './adapters/falabella.catalog.js';
import { hitesCatalogAdapter } from './adapters/hites.catalog.js';
import type { CatalogAdapter, MappedCatalogItem } from './adapters/types.js';

/** Adaptadores de catálogo por código de retailer. Un retailer nuevo se agrega aquí. */
const ADAPTERS: Record<string, CatalogAdapter> = {
  [falabellaCatalogAdapter.retailerCode]: falabellaCatalogAdapter,
  [cencosudCatalogAdapter.retailerCode]: cencosudCatalogAdapter,
  [walmartCatalogAdapter.retailerCode]: walmartCatalogAdapter,
  [hitesCatalogAdapter.retailerCode]: hitesCatalogAdapter,
};

const CHUNK_SIZE = 500;

/** Estado de los productos ingresados a mano desde la conciliación */
export const MANUAL_STATUS = 'MANUAL';

/** Columnas que se devuelven de cada producto del catálogo (con su master) */
const CATALOG_COLUMNS = {
  id: retailerProducts.id,
  retailerSku: retailerProducts.retailerSku,
  sellerSku: retailerProducts.sellerSku,
  name: retailerProducts.name,
  listPrice: retailerProducts.listPrice,
  offerPrice: retailerProducts.offerPrice,
  offerFrom: retailerProducts.offerFrom,
  offerTo: retailerProducts.offerTo,
  status: retailerProducts.status,
  stock: retailerProducts.stock,
  imageUrl: retailerProducts.imageUrl,
  productId: retailerProducts.productId,
  productSku: products.skuMaster,
  productName: products.name,
};

export interface CatalogImportResult {
  retailer: string;
  fileName: string;
  totalRows: number;
  /** Productos nuevos (quedan sin master) */
  inserted: number;
  /** Productos que ya existían: se actualizaron nombre y precios, se mantiene el master */
  updated: number;
  errors: { row: number; message: string }[];
  /** Productos que están en el sistema pero NO vienen en este archivo (para decidir si eliminarlos) */
  missing: Awaited<ReturnType<CatalogService['list']>>;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Retailers cuyo catálogo se puede cargar, con cuántos productos tienen y cuántos sin master */
  async availableRetailers() {
    const counts = await this.db
      .select({
        code: retailers.code,
        total: count(),
        unassigned: sql<number>`count(*) filter (where ${retailerProducts.productId} is null)`.mapWith(Number),
      })
      .from(retailerProducts)
      .innerJoin(retailers, eq(retailerProducts.retailerId, retailers.id))
      .groupBy(retailers.code);

    return Object.values(ADAPTERS).map((a) => {
      const c = counts.find((x) => x.code === a.retailerCode);
      return { code: a.retailerCode, name: a.retailerName, total: c?.total ?? 0, unassigned: c?.unassigned ?? 0 };
    });
  }

  /** Catálogo de un retailer, ordenado por nombre */
  async list(retailerCode: string) {
    const retailerId = await this.findRetailerId(retailerCode);
    if (!retailerId) return [];
    return this.db
      .select(CATALOG_COLUMNS)
      .from(retailerProducts)
      .leftJoin(products, eq(retailerProducts.productId, products.id))
      .where(eq(retailerProducts.retailerId, retailerId))
      .orderBy(asc(retailerProducts.name));
  }

  /**
   * Carga el archivo de catálogo de un retailer:
   *  - productos nuevos -> se agregan sin master
   *  - productos existentes -> se actualizan nombre y precios (el master se mantiene)
   *  - productos del sistema que no vienen en el archivo -> se devuelven en "missing"
   *    para que el usuario decida si eliminarlos (no se borran solos)
   */
  async importFile(retailerCode: string, fileName: string, buffer: Buffer): Promise<CatalogImportResult> {
    const adapter = ADAPTERS[retailerCode.toUpperCase()];
    if (!adapter) throw new BadRequestException(`No hay adaptador de catálogo para "${retailerCode}"`);

    const { rows } = await readExcelTable(buffer, adapter.requiredHeaders, adapter.retailerName, fileName);

    const errors: CatalogImportResult['errors'] = [];
    const bySku = new Map<string, MappedCatalogItem>(); // si un SKU viene 2 veces, gana la última fila
    for (const { rowNumber, values } of rows) {
      try {
        const item = adapter.mapRow(values);
        bySku.set(item.retailerSku, item);
      } catch (err) {
        if (!(err instanceof RowError)) throw err;
        errors.push({ row: rowNumber, message: err.message });
      }
    }
    const items = [...bySku.values()];
    const retailerId = await this.getOrCreateRetailer(adapter);

    let inserted = 0;
    let updated = 0;
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        const result = await tx
          .insert(retailerProducts)
          .values(items.slice(i, i + CHUNK_SIZE).map((item) => ({ ...item, retailerId })))
          .onConflictDoUpdate({
            target: [retailerProducts.retailerId, retailerProducts.retailerSku],
            set: {
              sellerSku: sql`excluded.seller_sku`,
              name: sql`excluded.name`,
              listPrice: sql`excluded.list_price`,
              offerPrice: sql`excluded.offer_price`,
              offerFrom: sql`excluded.offer_from`,
              offerTo: sql`excluded.offer_to`,
              status: sql`excluded.status`,
              stock: sql`excluded.stock`,
              imageUrl: sql`excluded.image_url`,
              raw: sql`excluded.raw`,
              updatedAt: new Date(),
            },
          })
          // xmax = 0 => la fila es nueva; si no, se actualizó
          .returning({ isNew: sql<boolean>`(xmax = 0)` });
        result.forEach((r) => (r.isNew ? inserted++ : updated++));
      }
    });

    // Productos ingresados a mano desde la conciliación que ahora sí vienen en el catálogo:
    // el producto real hereda su master y el ingreso manual se elimina
    await this.mergeManualItems(retailerId);

    // Productos del sistema que no vienen en este archivo (los ingresados a mano no cuentan)
    const missing = await this.db
      .select(CATALOG_COLUMNS)
      .from(retailerProducts)
      .leftJoin(products, eq(retailerProducts.productId, products.id))
      .where(
        and(
          eq(retailerProducts.retailerId, retailerId),
          sql`${retailerProducts.status} is distinct from ${MANUAL_STATUS}`,
          items.length ? notInArray(retailerProducts.retailerSku, [...bySku.keys()]) : undefined,
        ),
      )
      .orderBy(asc(retailerProducts.name));

    this.logger.log(
      `Catálogo ${adapter.retailerCode} "${fileName}": ${inserted} nuevos, ${updated} actualizados, ` +
        `${missing.length} no vienen en el archivo, ${errors.length} con error`,
    );

    return { retailer: adapter.retailerName, fileName, totalRows: rows.length, inserted, updated, errors, missing };
  }

  /**
   * Ingreso manual desde la conciliación: una venta cuyo producto no está en el catálogo
   * (o no tiene master) queda unida al master elegido.
   *  - Si el producto ya existe en el catálogo del retailer (mismo SKU seller, o mismo nombre
   *    cuando la venta no trae SKU), solo se le asigna el master.
   *  - Si no existe, se crea en el catálogo como "MANUAL" con ese SKU seller y nombre.
   */
  async manualAssign(input: { retailerCode: string; sellerSku: string | null; name: string; productId: string }) {
    const [master] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, input.productId));
    if (!master) throw new NotFoundException('Producto master no encontrado');
    const retailerId = await this.findRetailerId(input.retailerCode);
    if (!retailerId) throw new NotFoundException(`Retailer "${input.retailerCode}" no existe`);

    const sellerSku = input.sellerSku?.trim() || null;
    const name = input.name.trim().replace(/\s+/g, ' ');

    const existing = await this.db
      .update(retailerProducts)
      .set({ productId: input.productId })
      .where(
        and(
          eq(retailerProducts.retailerId, retailerId),
          sellerSku
            ? sql`upper(${retailerProducts.sellerSku}) = upper(${sellerSku})`
            : sql`lower(trim(${retailerProducts.name})) = lower(${name})`,
        ),
      )
      .returning({ id: retailerProducts.id });
    if (existing.length > 0) return { created: false, updated: existing.length };

    await this.db.insert(retailerProducts).values({
      retailerId,
      // Clave propia para no chocar con los SKU reales del retailer
      retailerSku: `MANUAL:${sellerSku ?? name}`.slice(0, 80),
      sellerSku,
      name,
      status: MANUAL_STATUS,
      productId: input.productId,
    });
    return { created: true, updated: 0 };
  }

  /** Une los ingresos manuales con su producto real cuando este aparece en el catálogo */
  private async mergeManualItems(retailerId: string) {
    await this.db.execute(sql`
      update retailer_products real
      set product_id = manual.product_id, updated_at = now()
      from retailer_products manual
      where real.retailer_id = ${retailerId}
        and manual.retailer_id = ${retailerId}
        and manual.status = ${MANUAL_STATUS}
        and real.status is distinct from ${MANUAL_STATUS}
        and real.product_id is null
        and (
          upper(real.seller_sku) = upper(manual.seller_sku)
          or (manual.seller_sku is null and lower(trim(real.name)) = lower(trim(manual.name)))
        )
    `);
    await this.db.execute(sql`
      delete from retailer_products manual
      using retailer_products real
      where manual.retailer_id = ${retailerId}
        and real.retailer_id = ${retailerId}
        and manual.status = ${MANUAL_STATUS}
        and real.status is distinct from ${MANUAL_STATUS}
        and (
          upper(real.seller_sku) = upper(manual.seller_sku)
          or (manual.seller_sku is null and lower(trim(real.name)) = lower(trim(manual.name)))
        )
    `);
  }

  /** Asigna un master (o lo quita con null) a uno o varios productos del catálogo */
  async assign(ids: string[], productId: string | null) {
    if (productId) {
      const [exists] = await this.db.select({ id: products.id }).from(products).where(eq(products.id, productId));
      if (!exists) throw new NotFoundException('Producto master no encontrado');
    }
    const rows = await this.db
      .update(retailerProducts)
      .set({ productId })
      .where(inArray(retailerProducts.id, ids))
      .returning({ id: retailerProducts.id });
    return { updated: rows.length };
  }

  /** Elimina productos del catálogo (los que el retailer ya no usa) */
  async remove(ids: string[]) {
    const rows = await this.db
      .delete(retailerProducts)
      .where(inArray(retailerProducts.id, ids))
      .returning({ id: retailerProducts.id });
    return { deleted: rows.length };
  }

  private async findRetailerId(code: string) {
    const [row] = await this.db
      .select({ id: retailers.id })
      .from(retailers)
      .where(eq(retailers.code, code.toUpperCase()));
    return row?.id ?? null;
  }

  private async getOrCreateRetailer(adapter: CatalogAdapter): Promise<string> {
    await this.db
      .insert(retailers)
      .values({ code: adapter.retailerCode, name: adapter.retailerName })
      .onConflictDoNothing({ target: [retailers.tenantId, retailers.code] });
    return (await this.findRetailerId(adapter.retailerCode))!;
  }
}