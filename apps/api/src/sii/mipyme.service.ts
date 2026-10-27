import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { creditNotes, customerReceipts, dispatchGuides, retailers } from '../database/schema/index.js';
import { SalesService } from '../sales/sales.service.js';
import { ApiGatewayClient, SiiRejectedError, SiiUnknownError } from './api-gateway.client.js';
import { SiiProviderService } from './sii-provider.service.js';
import { SiiPublicClient } from './providers/sii-public.client.js';
import { siiRut } from './rut.js';
import { showsCustomerOrderId } from '../settlements/reconciliation.service.js';
import { PRICING_CHANNELS } from '@cuadra/shared';
import { amount, picker, portalDoc, rutBody, type PortalDoc } from './sii-rows.js';
import { SiiService } from './sii.service.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const dateCL = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d);
const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);
/** Línea de una factura: código, producto, OC y retail donde se vendió, y el monto neto */
export interface InvoiceLine {
  orderNumber: string;
  code: string | null;
  name: string;
  oc: string;
  /** Retail donde se vendió (Walmart, Paris…) */
  origin: string | null;
  quantity: number;
  unitNet: number | null;
  net: number;
}

/** Bajo el nombre del producto en la factura: "OC 8965… · Cliente Walmart" */
const lineDescription = (l: InvoiceLine) => [`OC ${l.oc}`, l.origin ? `Cliente ${l.origin}` : null].filter(Boolean).join(' · ');

/** Corta en una palabra completa (para el giro, que el SII limita a 40 caracteres) */
const cutWords = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const c = t.slice(0, max + 1);
  const i = c.lastIndexOf(' ');
  return (i > max * 0.5 ? c.slice(0, i) : t.slice(0, max)).trim();
};

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
    private readonly siiPublic: SiiPublicClient,
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
    const fromNubox = await this.provider
      .pdfFromRaw(row.raw, kind === 'nota-credito' ? 61 : 52)
      .catch((err) => gatewayError(err, 'No se pudo obtener el PDF de Nubox'));
    if (fromNubox) return { data: fromNubox, fileName: `${prefixOf}_${row.folio ?? 'nubox'}${row.order ? `_${row.order}` : ''}.pdf` };
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
      receptor: await this.completeReceptor({
        rut: siiRut(b?.rut ?? data.customer.rut) ?? '',
        name: (b?.legalName ?? '').trim(),
        activity: (b?.activity ?? '').trim(),
        address: (b?.address ?? data.shipping.address ?? '').trim(),
        commune: (data.shipping.commune ?? '').trim(),
      }),
    };
  }

  /**
   * Completa lo que falte del receptor de una factura, sin pisar lo que ya trae:
   *  1. los datos de la última factura hecha a ese RUT (Cuadra los recuerda)
   *  2. razón social y giro según el SII
   */
  async completeReceptor(r: FacturaReceptor): Promise<FacturaReceptor> {
    const out = { ...r };
    const blank = (k: keyof FacturaReceptor) => !out[k]?.trim();
    const rut = siiRut(out.rut);
    if (!rut) return out;
    if ((['name', 'activity', 'address', 'commune'] as const).some(blank)) {
      const [last] = await this.db
        .select({ receptor: customerReceipts.receptor })
        .from(customerReceipts)
        .where(and(eq(customerReceipts.documentType, 33), sql`${customerReceipts.receptor}->>'rut' = ${rut}`))
        .orderBy(sql`${customerReceipts.createdAt} desc`)
        .limit(1);
      const k = last?.receptor as FacturaReceptor | null;
      if (k) for (const f of ['name', 'activity', 'address', 'commune'] as const) if (blank(f) && k[f]) out[f] = k[f];
    }
    if (blank('name') || blank('activity')) {
      const c = await this.contribuyenteData(rut).catch(() => null);
      if (c) {
        if (blank('name') && c.razonSocial) out.name = cut(c.razonSocial, 100);
        if (blank('activity') && c.actividades[0]) out.activity = cutWords(c.actividades[0].glosa, 40);
        if (blank('address') && c.direcciones[0]) {
          out.address = cut(c.direcciones[0].direccion, 70);
          if (blank('commune')) out.commune = cut(c.direcciones[0].comuna, 20);
        }
      }
    }
    return out;
  }

  /** Datos del SII de un RUT: por API Gateway si está conectado (trae direcciones); si no, la consulta pública */
  private async contribuyenteData(rut: string): Promise<{ razonSocial: string | null; direcciones: { direccion: string; comuna: string }[]; actividades: { codigo: string; glosa: string }[] }> {
    try {
      const g = await this.gateway.contribuyente(rut);
      return { razonSocial: g.razonSocial ?? null, direcciones: g.direcciones ?? [], actividades: g.actividades ?? [] };
    } catch {
      const p = await this.siiPublic.contribuyente(rut);
      return { razonSocial: p.razonSocial, direcciones: [], actividades: p.actividades };
    }
  }

  /** Razón social, dirección y giros de una empresa según el SII */
  async contribuyente(rut: string) {
    const clean = siiRut(rut);
    if (!clean) throw new BadRequestException('RUT inválido');
    try {
      return { rut: clean, ...(await this.contribuyenteData(clean)) };
    } catch (err) {
      throw new BadGatewayException(`El SII no entregó los datos de ese RUT: ${(err as Error).message}`);
    }
  }

  /** Arma la factura (33) de la orden como borrador en el Portal MIPYME */
  async createFactura(retailerCode: string, orderNumber: string, receptor: FacturaReceptor, userId: string | null) {
    // Mismo formato que la factura de varias ventas: una línea por producto (código, nombre,
    // OC y retail donde se vendió) más el despacho, con montos netos
    const r = await this.createFacturaLote(retailerCode, [orderNumber], receptor, userId);
    return { id: r.ids[0], folio: r.folio ?? undefined, draftCode: r.draftCode, retail: r.retail };
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

  // ------------------------------------------------------------------ Factura de varias ventas

  /**
   * Lo que llevaría una factura de varias órdenes del mismo cliente: una línea por producto con
   * su nombre y OC, cantidad y precio unitario neto. Avisa lo que impide emitirla.
   */
  async facturaLotePreview(retailerCode: string, orderNumbers: string[]) {
    const code = retailerCode.toUpperCase();
    const [r] = await this.db.select({ id: retailers.id, name: retailers.name }).from(retailers).where(eq(retailers.code, code));
    if (!r) throw new NotFoundException('El canal no existe');
    const { rows } = await this.db.execute<{
      order_number: string;
      order_id: string | null;
      name: string | null;
      sku: string | null;
      origin: string | null;
      quantity: number;
      unit: number | null;
      gross: boolean;
      billing_tax_id: string | null;
      billing_legal_name: string | null;
      billing_activity: string | null;
      billing_address: string | null;
    }>(sql`
      select s.order_number, s.order_id, coalesce(sn.name, s.product_name) as name,
        coalesce(sn.parent_sku, s.seller_sku) as sku, s.raw->>'retailer' as origin, s.quantity,
        coalesce(s.paid_price, s.unit_price)::float8 as unit, s.amounts_include_tax as gross,
        s.billing_tax_id, s.billing_legal_name, s.billing_activity, s.billing_address
      from sales_records s
      left join retail_sku_names sn on sn.provider = ${code} and sn.seller_sku = upper(s.seller_sku)
      where s.retailer_id = ${r.id} and s.order_number in (${sql.join(orderNumbers.map((n) => sql`${n}`), sql`, `)})
        and coalesce(s.status, '') !~* 'cancel|anulad'
      order by s.order_number, s.external_item_id
    `);
    const existing = await this.db
      .select({ orderNumber: customerReceipts.orderNumber, number: customerReceipts.receiptNumber, status: customerReceipts.status })
      .from(customerReceipts)
      .where(and(eq(customerReceipts.retailerId, r.id), sql`${customerReceipts.orderNumber} in (${sql.join(orderNumbers.map((n) => sql`${n}`), sql`, `)})`));

    const problems: string[] = [];
    for (const e of existing) problems.push(`La orden ${e.orderNumber} ya tiene documento ${e.status === 'BORRADOR' ? 'en borrador' : `N° ${e.number}`}`);
    const found = new Set(rows.map((x) => x.order_number));
    for (const n of orderNumbers) if (!found.has(n)) problems.push(`La orden ${n} no tiene productos (¿cancelada?)`);

    // Retail donde se vendió: el mismo canal, o el que informó el cliente de Cuadra que la envió
    const channel = PRICING_CHANNELS.find((c) => c.code === code)?.label ?? r.name;
    const ocOf = (x: { order_number: string; order_id: string | null }) => (showsCustomerOrderId(code) ? (x.order_id ?? x.order_number) : x.order_number);
    const lines: InvoiceLine[] = rows.map((x) => ({
      orderNumber: x.order_number,
      code: (x.sku ?? '').trim().toUpperCase() || null,
      name: cut(x.name ?? 'Producto', 80),
      oc: ocOf(x),
      origin: code.startsWith('CLI-') ? (x.origin ?? null) : channel,
      quantity: Math.max(1, Number(x.quantity) || 1),
      unitNet: x.unit === null ? null : Math.round(x.gross ? x.unit / 1.19 : x.unit),
      net: 0,
    }));
    // Lo que pagó el cliente por el despacho, en una línea por orden (si lo hubo)
    for (const n of found) {
      const ship = await this.sales.customerData(code, n, true).then((d) => d.shippingTotal).catch(() => 0);
      const first = rows.find((x) => x.order_number === n)!;
      if (ship > 0)
        lines.push({ orderNumber: n, code: 'DESPACHO', name: 'Despacho', oc: ocOf(first), origin: lines.find((l) => l.orderNumber === n)?.origin ?? null, quantity: 1, unitNet: Math.round(ship / 1.19), net: 0 });
    }
    lines.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber) || Number(a.code === 'DESPACHO') - Number(b.code === 'DESPACHO'));
    for (const l of lines) l.net = (l.unitNet ?? 0) * l.quantity;
    const noPrice = [...new Set(lines.filter((l) => !l.unitNet).map((l) => l.name))];
    if (noPrice.length) problems.push(`Sin precio: ${noPrice.slice(0, 3).join(', ')}${noPrice.length > 3 ? '…' : ''} (ponlo en Productos)`);
    const net = lines.reduce((n, l) => n + l.net, 0);
    const vat = Math.round(net * 0.19);

    // Receptor: el de la última factura a este cliente; si no, los datos de facturación de la venta
    const [last] = await this.db
      .select({ receptor: customerReceipts.receptor })
      .from(customerReceipts)
      .where(and(eq(customerReceipts.retailerId, r.id), eq(customerReceipts.documentType, 33), sql`${customerReceipts.receptor} is not null`))
      .orderBy(sql`${customerReceipts.createdAt} desc`)
      .limit(1);
    const b = rows[0];
    const base = (last?.receptor as FacturaReceptor | null) ?? {
      rut: siiRut(b?.billing_tax_id) ?? '',
      name: (b?.billing_legal_name ?? '').trim(),
      activity: (b?.billing_activity ?? '').trim(),
      address: (b?.billing_address ?? '').trim(),
      commune: '',
    };
    const receptor = await this.completeReceptor(base);
    const status = await this.provider.status();
    return {
      retailerCode: code,
      client: r.name,
      orders: orderNumbers,
      lines,
      net,
      vat,
      total: net + vat,
      receptor,
      direct: status.supports.facturasDirectas,
      providerName: status.providerName,
      problems,
    };
  }

  /**
   * Una factura (33) para varias órdenes del mismo cliente. Cada orden queda con ese documento
   * (con su parte del total), así Ventas las muestra facturadas.
   */
  async createFacturaLote(retailerCode: string, orderNumbers: string[], receptor: FacturaReceptor, userId: string | null) {
    const p = await this.facturaLotePreview(retailerCode, orderNumbers);
    if (p.problems.length) throw new BadRequestException(p.problems.join(' · '));
    if (p.net <= 0) throw new BadRequestException('La factura no tiene monto');
    const rut = siiRut(receptor.rut);
    if (!rut) throw new BadRequestException('RUT del receptor inválido');
    const rec = { ...receptor, rut };
    const [r] = await this.db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, p.retailerCode));
    // Total con IVA de cada orden (para que cada venta muestre su parte)
    const byOrder = new Map<string, number>();
    for (const l of p.lines) byOrder.set(l.orderNumber, (byOrder.get(l.orderNumber) ?? 0) + l.net);
    const gross = (n: string) => String(Math.round((byOrder.get(n) ?? 0) * 1.19));
    const today = todayCL();
    const lines = p.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitNet: l.unitNet!, code: l.code, description: lineDescription(l) }));

    if (!p.direct) {
      // API Gateway: borrador en el Portal MIPYME (precios netos)
      const { rut: emisor } = await this.gateway.config();
      const dte = {
        Encabezado: {
          IdDoc: { TipoDTE: 33, FchEmis: today, FmaPago: 1 },
          Emisor: { RUTEmisor: emisor },
          Receptor: {
            RUTRecep: rut,
            RznSocRecep: cut(receptor.name, 100),
            GiroRecep: cut(receptor.activity, 40),
            DirRecep: cut(receptor.address, 70),
            CmnaRecep: cut(receptor.commune, 20),
          },
        },
        Detalle: lines.map((l) => ({
          ...(l.code ? { CdgItem: [{ TpoCodigo: 'INT1', VlrCodigo: cut(l.code, 35) }] } : {}),
          NmbItem: cut(l.name, 80),
          ...(l.description ? { DscItem: cut(l.description, 1000) } : {}),
          QtyItem: l.quantity,
          PrcItem: l.unitNet,
        })),
      };
      const draft = await this.gateway.crearBorrador(dte).catch((err) => gatewayError(err, 'El Portal MIPYME rechazó la factura'));
      const draftIds: string[] = [];
      for (const n of p.orders) {
        const [row] = await this.db.insert(customerReceipts).values({
          retailerId: r.id,
          orderNumber: n,
          receiptNumber: `B-${draft.draftCode}`,
          totalGross: gross(n),
          documentType: 33,
          status: 'BORRADOR',
          draftCode: draft.draftCode,
          receptor: rec,
          siiResponse: draft.raw,
          createdBy: userId,
        }).returning({ id: customerReceipts.id });
        draftIds.push(row.id);
      }
      return { ids: draftIds, folio: null, draftCode: draft.draftCode, orders: p.orders.length, total: p.total, retail: null };
    }

    // Nubox: se emite al tiro. Antes se reservan las órdenes (no se factura dos veces)
    await this.provider.require('facturas', 'emitir facturas');
    const ids: string[] = [];
    try {
      for (const n of p.orders) {
        const [row] = await this.db
          .insert(customerReceipts)
          .values({ retailerId: r.id, orderNumber: n, receiptNumber: 'EMITIENDO', totalGross: gross(n), documentType: 33, status: 'EMITIENDO', receptor: rec, createdBy: userId })
          .returning({ id: customerReceipts.id });
        ids.push(row.id);
      }
    } catch {
      if (ids.length) await this.db.delete(customerReceipts).where(sql`${customerReceipts.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
      throw new ConflictException('Alguna de las órdenes ya tiene documento o se está facturando');
    }
    const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    try {
      const result = await this.provider.emitirFactura({ fecha: today, receptor: rec, item: lines[0].name, total: p.total, lines });
      await this.db
        .update(customerReceipts)
        .set({ receiptNumber: String(result.folio), status: 'EMITIDA', issuedAt: today, pdfUrl: result.pdfUrl, pdfData: result.pdfBase64, siiResponse: result.raw })
        .where(sql`${customerReceipts.id} in (${idList})`);
      // Paris, Falabella y Ripley piden también las facturas en su portal
      let retail: Awaited<ReturnType<SiiService['sendToRetailer']>> = null;
      for (const id of ids) retail = (await this.sii.sendToRetailer(id, { onlyIfReady: true })) ?? retail;
      return { ids, folio: result.folio, draftCode: null, orders: p.orders.length, total: p.total, retail };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof SiiRejectedError || (err as { status?: number }).status === 400) {
        await this.db.delete(customerReceipts).where(sql`${customerReceipts.id} in (${idList})`);
        throw new BadGatewayException(`${p.providerName} rechazó la factura: ${message}`);
      }
      await this.db
        .update(customerReceipts)
        .set({ status: 'REVISAR', receiptNumber: 'REVISAR', siiResponse: { error: message } })
        .where(sql`${customerReceipts.id} in (${idList})`);
      throw new BadGatewayException(`No se pudo confirmar la factura (${message}). Revisa en ${p.providerName} si quedó emitida antes de reintentar.`);
    }
  }
}
