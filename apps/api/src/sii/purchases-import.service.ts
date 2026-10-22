import { BadGatewayException, BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { purchaseDocuments, suppliers } from '../database/schema/index.js';
import { SiiRejectedError, SiiUnknownError } from './api-gateway.client.js';
import { SiiProviderService } from './sii-provider.service.js';
import { siiRut } from './rut.js';
import { amount, isoDate, normKey } from './sii-rows.js';

export const DOCUMENT_TYPES: Record<number, string> = {
  29: 'Factura de inicio',
  30: 'Factura',
  32: 'Factura no afecta',
  33: 'Factura electrónica',
  34: 'Factura exenta',
  45: 'Factura de compra',
  46: 'Factura de compra electrónica',
  55: 'Nota de débito',
  56: 'Nota de débito electrónica',
  60: 'Nota de crédito',
  61: 'Nota de crédito electrónica',
  914: 'Declaración de ingreso (importación)',
};

/** Las notas de crédito restan */
export const isCreditNote = (type: number) => type === 60 || type === 61;

type ErpStatus = 'NUEVA' | 'COINCIDE' | 'IMPORTADA';

/** Un documento del Registro de Compras del SII, comparado con lo que hay en el ERP */
export interface SiiPurchase {
  key: string;
  type: number;
  typeLabel: string;
  supplierRut: string;
  supplierName: string;
  folio: string;
  issueDate: string | null;
  receivedAt: string | null;
  exempt: number;
  net: number;
  vat: number;
  total: number;
  /** REGISTRO (aceptada) o PENDIENTE (recibida hace menos de 8 días) */
  siiStatus: 'REGISTRO' | 'PENDIENTE';
  /**
   * NUEVA      no está en el ERP: se crea al importar
   * COINCIDE   ya se ingresó a mano: al importar se le agregan los montos del SII
   * IMPORTADA  ya se trajo antes
   */
  erpStatus: ErpStatus;
  documentId: string | null;
  /** Proveedor como quedó (o quedará) en el ERP */
  erpSupplier: string | null;
  /** Neto ya asignado a órdenes en el ERP */
  assignedNet: number;
  /**
   * La emitió un retailer (comisiones, logística): se guarda aparte para cuadrar con las
   * liquidaciones; no es deuda con proveedores ni se suma al IVA crédito (ya está en la liquidación)
   */
  retailer: { id: string; name: string } | null;
}

interface Normalized extends Omit<SiiPurchase, 'erpStatus' | 'documentId' | 'erpSupplier' | 'assignedNet' | 'retailer'> {
  raw: Record<string, unknown>;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Fila del SII (nombres "det…" del JSON o columnas del CSV del RCV) -> documento */
function normalize(row: Record<string, unknown>, siiStatus: 'REGISTRO' | 'PENDIENTE'): Normalized | null {
  const map = new Map(Object.entries(row).map(([k, v]) => [normKey(k), v]));
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = map.get(n);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const type = Number(pick('dettipodoc', 'tipodoc', 'tipodocumento', 'tipodte', 'dte'));
  const folio = pick('detnrodoc', 'folio', 'nrodoc');
  const rutBody = pick('detrutdoc', 'rutproveedor', 'rutemisor', 'rut');
  const dv = pick('detdvdoc', 'dvproveedor');
  const rut = siiRut(dv !== undefined && !String(rutBody).includes('-') ? `${rutBody}-${dv}` : String(rutBody ?? ''));
  if (!type || folio === undefined || !rut) return null;
  const total = amount(pick('detmnttotal', 'montototal', 'total'));
  const vat = amount(pick('detmntiva', 'montoivarecuperable', 'montoiva', 'iva'));
  return {
    key: `${type}-${rut}-${String(folio).trim()}`,
    type,
    typeLabel: DOCUMENT_TYPES[type] ?? `Documento ${type}`,
    supplierRut: rut,
    supplierName: String(pick('detrznsoc', 'razonsocial', 'rznsoc') ?? rut).trim(),
    folio: String(folio).trim(),
    issueDate: isoDate(pick('detfchdoc', 'fechadocto', 'fechadocumento', 'fchdoc', 'fechaemision', 'fecha')),
    receivedAt: isoDate(pick('detfecrecepcion', 'fecharecepcion')),
    exempt: Math.round(amount(pick('detmntexe', 'montoexento', 'exento'))),
    net: Math.round(amount(pick('detmntneto', 'montoneto', 'neto'))),
    vat: Math.round(vat),
    total: Math.round(total),
    siiStatus,
    raw: row,
  };
}

/**
 * Trae las facturas de compra del Registro de Compras y Ventas (RCV) del SII
 * a través de API Gateway (servicio "Registro de Compra y Venta").
 */
@Injectable()
export class PurchasesImportService {
  private readonly logger = new Logger(PurchasesImportService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly provider: SiiProviderService,
  ) {}

  /** Documentos del SII de un mes (AAAA-MM), marcando cuáles ya están en el ERP */
  async preview(month: string) {
    const { documents, warnings } = await this.fromSii(month);
    const matched = await this.match(documents);
    const sum = (rows: SiiPurchase[], f: (r: SiiPurchase) => number) =>
      rows.reduce((n, r) => n + (isCreditNote(r.type) ? -f(r) : f(r)), 0);
    return {
      month,
      warnings,
      documents: matched,
      totals: {
        count: matched.length,
        net: sum(matched, (r) => r.net),
        vat: sum(matched, (r) => r.vat),
        total: sum(matched, (r) => r.total),
        newCount: matched.filter((r) => r.erpStatus !== 'IMPORTADA').length,
        retailerCount: matched.filter((r) => r.retailer).length,
      },
    };
  }

  /** Importa los documentos elegidos (por su key) de un mes */
  async import(month: string, keys: string[], userId: string | null) {
    const { documents } = await this.fromSii(month);
    const wanted = new Set(keys);
    const chosen = documents.filter((d) => wanted.has(d.key));
    if (chosen.length === 0) throw new BadRequestException('Ninguno de los documentos elegidos está en el SII para ese mes');
    const matched = await this.match(chosen);
    const raw = new Map(documents.map((d) => [d.key, d.raw]));

    let created = 0;
    let linked = 0;
    let updated = 0;
    await this.db.transaction(async (tx) => {
      for (const d of matched) {
        const sii = {
          documentType: d.type,
          issueDate: d.issueDate ?? undefined,
          siiExempt: String(d.exempt),
          siiNet: String(d.net),
          siiVat: String(d.vat),
          siiTotal: String(d.total),
          siiStatus: d.siiStatus,
          siiImportedAt: new Date(),
          siiData: raw.get(d.key) ?? null,
          retailerId: d.retailer?.id ?? null,
        };
        if (d.documentId) {
          // Ya estaba (a mano o importada antes): se completan los datos del SII
          await tx.update(purchaseDocuments).set(sii).where(eq(purchaseDocuments.id, d.documentId));
          const [doc] = await tx
            .select({ supplierId: purchaseDocuments.supplierId })
            .from(purchaseDocuments)
            .where(eq(purchaseDocuments.id, d.documentId));
          await this.setSupplierRut(tx, doc.supplierId, d.supplierRut);
          if (d.erpStatus === 'COINCIDE') linked++;
          else updated++;
          continue;
        }
        const supplierId = await this.supplierFor(tx, d.supplierRut, d.supplierName);
        await tx.insert(purchaseDocuments).values({
          supplierId,
          documentNumber: d.folio,
          createdBy: userId,
          ...sii,
          issueDate: d.issueDate ?? sql`(now() at time zone 'America/Santiago')::date`,
        });
        created++;
      }
    });
    return { created, linked, updated };
  }

  // ---------------------------------------------------------------------------

  private async fromSii(month: string) {
    if (!MONTH.test(month)) throw new BadRequestException('Mes inválido (AAAA-MM)');
    const periodo = month.replace('-', '');
    const warnings: string[] = [];
    const call = async (estado: 'REGISTRO' | 'PENDIENTE') => {
      try {
        return (await this.provider.comprasRcv(periodo, estado))
          .map((r) => normalize(r, estado))
          .filter((r): r is Normalized => r !== null);
      } catch (err) {
        if (err instanceof SiiRejectedError || err instanceof SiiUnknownError) {
          // Sin documentos en el mes el SII a veces responde con error: no es grave
          if (/no (existen|hay|se encontraron)|sin (datos|registros|documentos)/i.test(err.message)) return [];
          if (estado === 'PENDIENTE') {
            warnings.push(`No se pudieron revisar las facturas pendientes de aceptar: ${err.message}`);
            return [];
          }
          throw new BadGatewayException(`El SII respondió (vía ${(await this.provider.status()).providerName}): ${err.message}`);
        }
        throw err;
      }
    };
    const registro = await call('REGISTRO');
    const pendiente = await call('PENDIENTE');
    const seen = new Set(registro.map((r) => r.key));
    const documents = [...registro, ...pendiente.filter((p) => !seen.has(p.key))].sort(
      (a, b) => (a.issueDate ?? '').localeCompare(b.issueDate ?? '') || a.supplierName.localeCompare(b.supplierName),
    );
    this.logger.log(`RCV compras ${month}: ${registro.length} en registro, ${pendiente.length} pendientes`);
    return { documents, warnings };
  }

  /** Compara con las facturas del ERP: por RUT + N°, o por nombre del proveedor + N° */
  private async match(documents: Normalized[]): Promise<SiiPurchase[]> {
    if (documents.length === 0) return [];
    const folios = [...new Set(documents.map((d) => d.folio))];
    const { rows } = await this.db.execute<{
      id: string;
      document_number: string;
      document_type: number;
      sii_imported_at: string | null;
      supplier: string;
      tax_id: string | null;
      assigned_net: number;
    }>(sql`
      select d.id, d.document_number, d.document_type, d.sii_imported_at::text, s.name as supplier, s.tax_id,
        coalesce((select sum(amount_net) from purchase_document_lines l where l.document_id = d.id), 0)::float8 as assigned_net
      from purchase_documents d join suppliers s on s.id = d.supplier_id
      where d.document_number in (${sql.join(folios.map((f) => sql`${f}`), sql`, `)})
    `);
    const { rows: known } = await this.db.execute<{ name: string; tax_id: string | null }>(sql`
      select name, tax_id from suppliers
    `);
    const byRut = new Map(known.filter((k) => k.tax_id).map((k) => [k.tax_id!, k.name]));
    // Retailers con RUT en la maestra
    const { rows: retailerRows } = await this.db.execute<{ id: string; name: string; tax_id: string }>(sql`
      select id, name, tax_id from retailers where tax_id is not null and tax_id <> ''
    `);
    const retailerByRut = new Map(
      retailerRows
        .map((r) => [siiRut(r.tax_id), { id: r.id, name: r.name }] as const)
        .filter((e): e is readonly [string, { id: string; name: string }] => e[0] !== null),
    );
    const used = new Set<string>();

    const result = documents.map(({ raw: _raw, ...d }) => {
      const sameNumber = rows.filter((r) => r.document_number === d.folio && r.document_type === d.type && !used.has(r.id));
      const hit =
        sameNumber.find((r) => r.tax_id === d.supplierRut) ??
        sameNumber.find((r) => !r.tax_id && r.supplier.trim().toLowerCase() === d.supplierName.toLowerCase()) ??
        // Ingresada a mano con otro nombre de proveedor: si es la única con ese N°, es esa
        (() => {
          const free = sameNumber.filter((r) => !r.tax_id);
          return free.length === 1 ? free[0] : undefined;
        })();
      if (hit) used.add(hit.id);
      return {
        ...d,
        erpStatus: (hit ? (hit.sii_imported_at ? 'IMPORTADA' : 'COINCIDE') : 'NUEVA') as ErpStatus,
        documentId: hit?.id ?? null,
        erpSupplier: hit?.supplier ?? byRut.get(d.supplierRut) ?? null,
        assignedNet: Math.round(hit?.assigned_net ?? 0),
        retailer: retailerByRut.get(d.supplierRut) ?? null,
      };
    });
    // Un proveedor ingresado a mano con otro nombre queda ligado a su RUT por cualquiera de sus facturas
    const nameByRut = new Map(result.filter((r) => r.documentId && r.erpSupplier).map((r) => [r.supplierRut, r.erpSupplier]));
    for (const r of result) if (!r.erpSupplier) r.erpSupplier = nameByRut.get(r.supplierRut) ?? null;
    return result;
  }

  /** Proveedor por RUT; si no, por nombre (y le anota el RUT); si no, lo crea */
  private async supplierFor(tx: Pick<Database, 'select' | 'insert' | 'update'>, rut: string, name: string) {
    const [byRut] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.taxId, rut));
    if (byRut) return byRut.id;
    const [byName] = await tx
      .select({ id: suppliers.id, taxId: suppliers.taxId })
      .from(suppliers)
      .where(sql`lower(${suppliers.name}) = lower(${name})`);
    if (byName) {
      if (!byName.taxId) await tx.update(suppliers).set({ taxId: rut }).where(eq(suppliers.id, byName.id));
      return byName.id;
    }
    const [created] = await tx.insert(suppliers).values({ name: name.slice(0, 200), taxId: rut }).returning({ id: suppliers.id });
    return created.id;
  }

  /** Anota el RUT al proveedor si no lo tenía y ningún otro lo usa */
  private async setSupplierRut(tx: Pick<Database, 'select' | 'update'>, supplierId: string, rut: string) {
    const [other] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.taxId, rut));
    if (other) return;
    await tx
      .update(suppliers)
      .set({ taxId: rut })
      .where(and(eq(suppliers.id, supplierId), sql`${suppliers.taxId} is null`));
  }
}
