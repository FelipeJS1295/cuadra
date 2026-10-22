import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { creditNotes, customerReceipts, dispatchGuides, retailers } from '../database/schema/index.js';
import { SalesService } from '../sales/sales.service.js';
import { ApiGatewayClient, SiiRejectedError, SiiUnknownError } from './api-gateway.client.js';
import { SiiProviderService } from './sii-provider.service.js';
import { siiRut } from './rut.js';
import { amount, picker, portalDoc, rutBody, type PortalDoc } from './sii-rows.js';
import { SiiService } from './sii.service.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const dateCL = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d);
const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Mensaje claro cuando el SII / API Gateway falla */
function gatewayError(err: unknown, what: string): never {
  if (err instanceof SiiRejectedError || err instanceof SiiUnknownError) {
    throw new BadGatewayException(`${what}: ${err.message}`);
  }
  throw err;
}

export interface FacturaReceptor {
  rut: string;
  name: string;
  activity: string;
  address: string;
  commune: string;
}

/** Borrador del ERP que se busca entre los documentos emitidos del portal */
interface PendingDraft {
  table: 'credit_notes' | 'customer_receipts' | 'dispatch_guides';
  id: string;
  type: number;
  draftCode: string;
  receptorRut: string | null;
  amount: number | null;
  createdAt: Date;
  label: string;
}

/**
 * Portal MIPYME del SII (vía API Gateway):
 *  - Revisa qué borradores (notas de crédito, facturas, guías) ya se firmaron y anota su folio.
 *  - Facturas de venta (33) como borrador para las órdenes que piden factura.
 *  - PDF de los documentos emitidos.
 *  - Cuadratura de las ventas del ERP contra el Registro de Ventas del SII.
 */
@Injectable()
export class MipymeService {
  private readonly logger = new Logger(MipymeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly gateway: ApiGatewayClient,
    private readonly sales: SalesService,
    private readonly sii: SiiService,
    private readonly provider: SiiProviderService,
  ) {}

  // ------------------------------------------------------------------ Sincronizar

  /**
   * Para cada borrador del ERP: si ya no está entre los borradores del portal, se busca
   * entre los emitidos (mismo tipo, mismo receptor, mismo monto) y se anota folio y fecha.
   */
  async sync() {
    const pending = await this.pendingDrafts();
    if (pending.length === 0) return { checked: 0, emitted: [], stillDraft: 0, notFound: [] };

    let draftCodes: Set<string>;
    try {
      const drafts = await this.gateway.borradores();
      draftCodes = new Set(drafts.map((d) => String(picker(d)('ehdrcodigo', 'codigo') ?? '')));
    } catch (err) {
      gatewayError(err, 'No se pudieron revisar los borradores del Portal MIPYME');
    }
    const signed = pending.filter((p) => !draftCodes.has(p.draftCode));
    if (signed.length === 0) return { checked: pending.length, emitted: [], stillDraft: pending.length, notFound: [] };

    const from = dateCL(new Date(Math.min(...signed.map((p) => p.createdAt.getTime())) - 86400000));
    let emitted: PortalDoc[];
    try {
      emitted = (await this.gateway.emitidosMipyme(from, todayCL()))
        .map(portalDoc)
        .filter((d): d is PortalDoc => d !== null);
    } catch (err) {
      gatewayError(err, 'No se pudieron leer los documentos emitidos del Portal MIPYME');
    }
    const used = await this.usedFolios();
    const done: { label: string; folio: string }[] = [];
    const notFound: string[] = [];

    for (const p of signed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const since = dateCL(p.createdAt);
      const candidates = emitted
        .filter(
          (e) =>
            e.type === p.type &&
            !used.has(`${e.type}-${e.folio}`) &&
            (!e.date || e.date >= since) &&
            (!p.receptorRut || !e.rutBody || e.rutBody === p.receptorRut) &&
            (p.amount === null || e.total === null || Math.abs(e.total - p.amount) <= 1),
        )
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      // Sin receptor ni monto para comparar no se adivina
      const hit = candidates.length === 1 || (candidates.length > 1 && (p.receptorRut || p.amount !== null)) ? candidates[0] : undefined;
      if (!hit) {
        notFound.push(p.label);
        continue;
      }
      used.add(`${hit.type}-${hit.folio}`);
      await this.markEmitted(p, hit);
      done.push({ label: p.label, folio: hit.folio });
    }
    this.logger.log(`MIPYME: ${pending.length} borradores, ${done.length} ya emitidos`);
    return { checked: pending.length, emitted: done, stillDraft: pending.length - signed.length, notFound };
  }

  private async pendingDrafts(): Promise<PendingDraft[]> {
    const [ncs, facturas, guides] = await Promise.all([
      this.db
        .select({
          id: creditNotes.id,
          draftCode: creditNotes.draftCode,
          amount: creditNotes.amountGross,
          createdAt: creditNotes.createdAt,
          siiResponse: creditNotes.siiResponse,
          orderNumber: creditNotes.orderNumber,
        })
        .from(creditNotes)
        .where(and(eq(creditNotes.status, 'BORRADOR'), sql`${creditNotes.draftCode} is not null`)),
      this.db
        .select({
          id: customerReceipts.id,
          draftCode: customerReceipts.draftCode,
          amount: customerReceipts.totalGross,
          createdAt: customerReceipts.createdAt,
          receptor: customerReceipts.receptor,
          orderNumber: customerReceipts.orderNumber,
        })
        .from(customerReceipts)
        .where(and(eq(customerReceipts.status, 'BORRADOR'), sql`${customerReceipts.draftCode} is not null`)),
      this.db
        .select({
          id: dispatchGuides.id,
          draftCode: dispatchGuides.draftCode,
          amount: dispatchGuides.totalGross,
          createdAt: dispatchGuides.createdAt,
          receptorRut: dispatchGuides.receptorRut,
        })
        .from(dispatchGuides)
        .where(and(eq(dispatchGuides.status, 'BORRADOR'), sql`${dispatchGuides.draftCode} is not null`)),
    ]);
    return [
      ...ncs.map((n) => {
        const raw = (n.siiResponse ?? {}) as Record<string, unknown>;
        return {
          table: 'credit_notes' as const,
          id: n.id,
          type: 61,
          draftCode: n.draftCode!,
          receptorRut: rutBody(raw.efxp_rut_recep) || null,
          amount: Math.round(Number(n.amount)),
          createdAt: n.createdAt,
          label: `Nota de crédito de la orden ${n.orderNumber}`,
        };
      }),
      ...facturas.map((f) => ({
        table: 'customer_receipts' as const,
        id: f.id,
        type: 33,
        draftCode: f.draftCode!,
        receptorRut: rutBody((f.receptor as { rut?: string } | null)?.rut) || null,
        amount: Math.round(Number(f.amount)),
        createdAt: f.createdAt,
        label: `Factura de la orden ${f.orderNumber}`,
      })),
      ...guides.map((g) => ({
        table: 'dispatch_guides' as const,
        id: g.id,
        type: 52,
        draftCode: g.draftCode!,
        receptorRut: rutBody(g.receptorRut) || null,
        // Una guía sin precios (solo traslado) no se compara por monto
        amount: Number(g.amount) > 0 ? Math.round(Number(g.amount)) : null,
        createdAt: g.createdAt,
        label: `Guía de despacho a ${g.receptorRut}`,
      })),
    ];
  }

  /** Folios ya anotados en el ERP (para no asignar el mismo dos veces) */
  private async usedFolios() {
    const { rows } = await this.db.execute<{ key: string }>(sql`
      select '61-' || folio as key from credit_notes where folio is not null
      union all select document_type || '-' || receipt_number from customer_receipts where status <> 'BORRADOR'
      union all select '52-' || folio from dispatch_guides where folio is not null
    `);
    return new Set(rows.map((r) => r.key));
  }

  private async markEmitted(p: PendingDraft, doc: PortalDoc) {
    const issuedAt = doc.date ?? todayCL();
    if (p.table === 'credit_notes') {
      await this.db
        .update(creditNotes)
        .set({ status: 'EMITIDA', folio: doc.folio, issuedAt, mipymeCode: doc.code })
        .where(eq(creditNotes.id, p.id));
    } else if (p.table === 'customer_receipts') {
      await this.db
        .update(customerReceipts)
        .set({ status: 'EMITIDA', receiptNumber: doc.folio, issuedAt, mipymeCode: doc.code })
        .where(eq(customerReceipts.id, p.id));
    } else {
      await this.db
        .update(dispatchGuides)
        .set({ status: 'EMITIDA', folio: doc.folio, issuedAt, mipymeCode: doc.code })
        .where(eq(dispatchGuides.id, p.id));
    }
  }

  // ------------------------------------------------------------------ PDF emitidos

  /** PDF de una nota de crédito, factura o guía emitida desde el portal */
  async emittedPdf(kind: 'nota-credito' | 'guia', id: string): Promise<{ data: Buffer; fileName: string }> {
    const row =
      kind === 'nota-credito'
        ? (await this.db.select({ code: creditNotes.mipymeCode, folio: creditNotes.folio, order: creditNotes.orderNumber, raw: creditNotes.siiResponse }).from(creditNotes).where(eq(creditNotes.id, id)))[0]
        : (await this.db.select({ code: dispatchGuides.mipymeCode, folio: dispatchGuides.folio, order: dispatchGuides.reference, raw: sql<unknown>`null` }).from(dispatchGuides).where(eq(dispatchGuides.id, id)))[0];
    if (!row) throw new NotFoundException('El documento no existe');
    const prefixOf = kind === 'nota-credito' ? 'NC' : 'Guia';
    // Emitida por Nubox
    const nuboxId = this.provider.nuboxId(row.raw);
    if (nuboxId) {
      const data = await this.provider.pdfNubox(nuboxId, false).catch((err) => gatewayError(err, 'No se pudo obtener el PDF de Nubox'));
      return { data, fileName: `${prefixOf}_${row.folio ?? nuboxId}${row.order ? `_${row.order}` : ''}.pdf` };
    }
    if (!row.code) throw new BadRequestException('El documento aún no está emitido en el Portal MIPYME (o se anotó a mano)');
    const data = await this.gateway.pdfMipyme('emitidos', row.code).catch((err) => gatewayError(err, 'No se pudo obtener el PDF'));
    const prefix = kind === 'nota-credito' ? 'NC' : 'Guia';
    return { data, fileName: `${prefix}_${row.folio ?? row.code}${row.order ? `_${row.order}` : ''}.pdf` };
  }

  // ------------------------------------------------------------------ Facturas de venta

  /** Datos para la factura de una orden: monto, detalle y los datos de facturación que trae el retailer */
  async facturaPreview(retailerCode: string, orderNumber: string) {
    const p = await this.sii.preview(retailerCode, orderNumber);
    const data = await this.sales.customerData(retailerCode, orderNumber);
    const b = data.billing;
    return {
      retailerCode: p.retailerCode,
      orderNumber,
      item: p.item,
      total: p.total,
      issueDate: p.issueDate,
      existing: p.existing,
      wantsInvoice: p.wantsInvoice,
      receptor: {
        rut: siiRut(b?.rut ?? data.customer.rut) ?? '',
        name: (b?.legalName ?? '').trim(),
        activity: (b?.activity ?? '').trim(),
        address: (b?.address ?? data.shipping.address ?? '').trim(),
        commune: (data.shipping.commune ?? '').trim(),
      },
    };
  }

  /** Razón social, dirección y giros de una empresa según el SII */
  async contribuyente(rut: string) {
    const clean = siiRut(rut);
    if (!clean) throw new BadRequestException('RUT inválido');
    try {
      return { rut: clean, ...(await this.gateway.contribuyente(clean)) };
    } catch (err) {
      gatewayError(err, 'El SII no entregó los datos de ese RUT');
    }
  }

  /** Arma la factura (33) de la orden como borrador en el Portal MIPYME */
  async createFactura(retailerCode: string, orderNumber: string, receptor: FacturaReceptor, userId: string | null) {
    const p = await this.sii.preview(retailerCode, orderNumber);
    if (p.existing) {
      throw new ConflictException(
        p.existing.status === 'BORRADOR'
          ? 'Esta orden ya tiene una factura en borrador: fírmala en el Portal MIPYME o elimínala'
          : `Esta orden ya tiene documento N° ${p.existing.number}`,
      );
    }
    if (p.total <= 0) throw new BadRequestException('La orden no tiene monto');
    const rut = siiRut(receptor.rut);
    if (!rut) throw new BadRequestException('RUT del receptor inválido');
    const { rut: emisor } = await this.gateway.config();
    const dte = {
      Encabezado: {
        // MntBruto = 1: el precio del detalle viene con IVA incluido
        IdDoc: { TipoDTE: 33, FchEmis: p.issueDate, MntBruto: 1, FmaPago: 1 },
        Emisor: { RUTEmisor: emisor },
        Receptor: {
          RUTRecep: rut,
          RznSocRecep: cut(receptor.name, 100),
          GiroRecep: cut(receptor.activity, 40),
          DirRecep: cut(receptor.address, 70),
          CmnaRecep: cut(receptor.commune, 20),
        },
      },
      Detalle: [{ NmbItem: cut(p.item, 80), QtyItem: 1, PrcItem: Math.round(p.total) }],
    };
    const draft = await this.gateway.crearBorrador(dte).catch((err) => gatewayError(err, 'El Portal MIPYME rechazó la factura'));
    const [r] = await this.db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, p.retailerCode));
    const [row] = await this.db
      .insert(customerReceipts)
      .values({
        retailerId: r.id,
        orderNumber,
        receiptNumber: `B-${draft.draftCode}`,
        totalGross: String(p.total),
        documentType: 33,
        status: 'BORRADOR',
        draftCode: draft.draftCode,
        receptor: { ...receptor, rut },
        siiResponse: draft.raw,
        createdBy: userId,
      })
      .returning({ id: customerReceipts.id });
    return { id: row.id, draftCode: draft.draftCode };
  }

  /** Quita una factura en borrador (del ERP y del portal) */
  async deleteFactura(id: string) {
    const [r] = await this.db.select().from(customerReceipts).where(eq(customerReceipts.id, id));
    if (!r) throw new NotFoundException('La factura no existe');
    if (r.status !== 'BORRADOR') throw new BadRequestException('Solo se puede quitar una factura en borrador');
    let portal: 'ELIMINADO' | 'NO_SE_PUDO' = 'ELIMINADO';
    if (r.draftCode) await this.gateway.eliminarBorrador(r.draftCode).catch(() => (portal = 'NO_SE_PUDO'));
    await this.db.delete(customerReceipts).where(eq(customerReceipts.id, id));
    return { deleted: true, portal };
  }

  // ------------------------------------------------------------------ Cuadratura de ventas

  /**
   * Compara lo emitido según el ERP (boletas, facturas, notas de crédito) con el Registro
   * de Ventas del SII del mes, por tipo de documento.
   */
  async salesCheck(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('Mes inválido (AAAA-MM)');
    const rows = await this.provider
      .ventasResumen(month.replace('-', ''))
      .catch((err) => {
        if (err instanceof BadRequestException) throw err;
        if (err instanceof SiiRejectedError && /no (existen|hay|se encontraron)|sin (datos|registros)/i.test(err.message)) return [];
        return gatewayError(err, 'No se pudo leer el Registro de Ventas del SII');
      });
    const sii = new Map<number, { name: string; count: number; total: number; vat: number }>();
    for (const row of rows) {
      const prev = sii.get(row.tipodoc) ?? { name: row.nombretipodoc, count: 0, total: 0, vat: 0 };
      prev.count += row.totaldocumentos;
      prev.total += row.montototal;
      prev.vat += row.montoiva;
      sii.set(row.tipodoc, prev);
    }

    const { rows: erp } = await this.db.execute<{ type: number; count: number; total: number }>(sql`
      -- Boletas anotadas a mano sin fecha: se usa la fecha de la orden (igual que el resumen de IVA)
      select cr.document_type as type, count(*)::int as count, sum(cr.total_gross)::float8 as total
      from customer_receipts cr
      left join lateral (select min(order_date) as order_date from sales_records s
        where s.retailer_id = cr.retailer_id and s.order_number = cr.order_number) o on true
      where cr.status in ('EMITIDA', 'REGISTRADA') and to_char(coalesce(cr.issued_at, o.order_date::date), 'YYYY-MM') = ${month}
      group by 1
      union all
      select 61, count(*)::int, sum(amount_gross)::float8
      from credit_notes
      where status in ('EMITIDA', 'REGISTRADA') and to_char(issued_at, 'YYYY-MM') = ${month}
      group by 1
    `);
    const names: Record<number, string> = { 33: 'Factura electrónica', 34: 'Factura exenta', 39: 'Boleta electrónica', 41: 'Boleta exenta', 56: 'Nota de débito', 61: 'Nota de crédito' };
    const types = [...new Set([...sii.keys(), ...erp.map((e) => e.type)])].sort((a, b) => a - b);
    return {
      month,
      types: types.map((type) => {
        const s = sii.get(type) ?? null;
        const e = erp.filter((x) => x.type === type);
        const erpCount = e.reduce((n, x) => n + x.count, 0);
        const erpTotal = Math.round(e.reduce((n, x) => n + x.total, 0));
        return {
          type,
          name: s?.name ?? names[type] ?? `Tipo ${type}`,
          erp: { count: erpCount, total: erpTotal },
          sii: s ? { count: s.count, total: s.total } : null,
          countDiff: s ? s.count - erpCount : null,
          totalDiff: s ? s.total - erpTotal : null,
        };
      }),
    };
  }
}
