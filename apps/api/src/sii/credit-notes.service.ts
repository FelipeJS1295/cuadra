import { CANCELLED_PATTERN } from '@cuadra/shared';
import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { creditNotes, customerReceipts, productReturns, retailers } from '../database/schema/index.js';
import { SalesService } from '../sales/sales.service.js';
import { ApiGatewayClient } from './api-gateway.client.js';
import { SiiProviderService, type CreditNoteResult } from './sii-provider.service.js';
import { RUT_GENERICO, siiRut } from './rut.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());

/** Notas que cuentan (rebajan la boleta y el IVA): las ya emitidas o anotadas */
export const NC_VALID = ['EMITIDA', 'REGISTRADA'];
/** Notas "vivas" (no se puede crear otra que pase el monto de la boleta) */
const NC_ACTIVE = ['BORRADOR', 'EMITIDA', 'REGISTRADA'];

export interface CreditNoteInput {
  retailerCode: string;
  orderNumber: string;
  amountGross: number;
  /** 1 anula la boleta · 3 corrige montos (devolución parcial) */
  refCode: 1 | 3;
  reason: string;
  returnId?: string | null;
}

type CreditNoteRow = {
  id: string;
  retailer_code: string;
  retailer: string;
  order_number: string;
  receipt_number: string;
  receipt_date: string | null;
  ref_code: number;
  reason: string;
  amount_gross: number;
  status: string;
  draft_code: string | null;
  folio: string | null;
  issued_at: string | null;
  error: string | null;
  notes: string | null;
  created_at: string;
  return_id: string | null;
  has_pdf: boolean;
  receipt_type: number;
};

type PendingRow = {
  retailer_code: string;
  retailer: string;
  order_number: string;
  order_id: string | null;
  order_date: string | null;
  product_name: string | null;
  status: string | null;
  receipt_number: string;
  receipt_total: number;
  receipt_date: string | null;
  credited: number;
};

/**
 * Notas de crédito: anulan (o rebajan) una boleta cuando la orden se cancela o se devuelve.
 * El ERP arma el borrador en el Portal MIPYME y el usuario lo firma allá.
 */
@Injectable()
export class CreditNotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly sales: SalesService,
    private readonly gateway: ApiGatewayClient,
    private readonly provider: SiiProviderService,
  ) {}

  async list() {
    const { rows } = await this.db.execute<CreditNoteRow>(sql`
      select n.id, r.code as retailer_code, r.name as retailer, n.order_number, n.receipt_number,
        n.receipt_date::text as receipt_date, n.ref_code, n.reason, n.amount_gross::float8 as amount_gross,
        n.status, n.draft_code, n.folio, n.issued_at::text as issued_at, (n.mipyme_code is not null or n.sii_response->>'provider' in ('NUBOX', 'NUBOX_CLASICO')) as has_pdf, n.receipt_type,
        n.sii_response->>'error' as error, n.notes,
        (n.created_at at time zone 'America/Santiago')::date::text as created_at,
        (select pr.id::text from product_returns pr where pr.credit_note_id = n.id limit 1) as return_id
      from credit_notes n join retailers r on r.id = n.retailer_id
      order by n.created_at desc
    `);
    return rows.map((r) => ({
      id: r.id,
      retailerCode: r.retailer_code,
      retailer: r.retailer,
      orderNumber: r.order_number,
      receiptNumber: r.receipt_number,
      receiptDate: r.receipt_date,
      refCode: r.ref_code,
      reason: r.reason,
      amountGross: Math.round(r.amount_gross),
      status: r.status,
      draftCode: r.draft_code,
      folio: r.folio,
      issuedAt: r.issued_at,
      error: r.error,
      notes: r.notes,
      createdAt: r.created_at,
      returnId: r.return_id,
      hasPdf: r.has_pdf,
      receiptType: r.receipt_type,
    }));
  }

  /**
   * Órdenes CANCELADAS que tienen boleta y a las que les falta nota de crédito
   * (sin nota, o con notas que no alcanzan el total de la boleta).
   */
  async pending() {
    const { rows } = await this.db.execute<PendingRow>(sql`
      with orders as (
        select s.retailer_id, s.order_number, min(s.order_id) as order_id, min(s.order_date)::text as order_date,
          string_agg(distinct s.product_name, ' + ') as product_name, min(s.status) as status
        from sales_records s
        group by 1, 2
        having bool_and(coalesce(s.status, '') ~* ${CANCELLED_PATTERN})
      )
      select r.code as retailer_code, r.name as retailer, o.order_number, o.order_id, o.order_date,
        o.product_name, o.status, cr.receipt_number, cr.total_gross::float8 as receipt_total,
        cr.issued_at::text as receipt_date,
        coalesce((select sum(n.amount_gross) from credit_notes n
          where n.retailer_id = cr.retailer_id and n.order_number = cr.order_number
            and n.status in ('BORRADOR', 'EMITIDA', 'REGISTRADA')), 0)::float8 as credited
      from orders o
      join customer_receipts cr on cr.retailer_id = o.retailer_id and cr.order_number = o.order_number
        and cr.status in ('EMITIDA', 'REGISTRADA')
      join retailers r on r.id = o.retailer_id
      order by o.order_date desc nulls last
    `);
    return rows
      .filter((r) => r.credited < r.receipt_total - 0.5)
      .map((r) => ({
        retailerCode: r.retailer_code,
        retailer: r.retailer,
        orderNumber: r.order_number,
        orderId: r.order_id,
        orderDate: r.order_date,
        productName: r.product_name,
        status: r.status,
        receiptNumber: r.receipt_number,
        receiptTotal: Math.round(r.receipt_total),
        receiptDate: r.receipt_date,
        credited: Math.round(r.credited),
        missing: Math.round(r.receipt_total - r.credited),
      }));
  }

  /** Boleta de la orden y cuánto se le puede rebajar todavía */
  async preview(retailerCode: string, orderNumber: string) {
    const [retailer] = await this.db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, retailerCode.toUpperCase()));
    if (!retailer) throw new BadRequestException(`Retailer "${retailerCode}" no existe`);
    const [receipt] = await this.db
      .select()
      .from(customerReceipts)
      .where(and(eq(customerReceipts.retailerId, retailer.id), eq(customerReceipts.orderNumber, orderNumber)));
    if (!receipt || !['EMITIDA', 'REGISTRADA'].includes(receipt.status)) {
      throw new BadRequestException('La orden no tiene boleta emitida: no hay nada que anular');
    }
    const [{ credited }] = await this.db
      .select({ credited: sql<number>`coalesce(sum(${creditNotes.amountGross}), 0)::float8` })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.retailerId, retailer.id),
          eq(creditNotes.orderNumber, orderNumber),
          inArray(creditNotes.status, NC_ACTIVE),
        ),
      );
    // Incluye líneas canceladas: la nota se hace justamente cuando la orden se cancela
    const data = await this.sales.customerData(retailerCode, orderNumber, true).catch(() => null);
    const total = Number(receipt.totalGross);
    // Factura: la nota va a nombre de la empresa que recibió la factura
    const r = (receipt.documentType === 33 ? receipt.receptor : null) as
      | { rut?: string; name?: string; activity?: string; address?: string; commune?: string }
      | null;
    if (r?.rut) {
      return {
        retailerId: retailer.id,
        retailerCode: retailerCode.toUpperCase(),
        orderNumber,
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        receiptType: receipt.documentType,
        receiptDate: receipt.issuedAt,
        receiptTotal: Math.round(total),
        credited: Math.round(credited),
        available: Math.round(total - credited),
        customerName: r.name ?? 'Cliente',
        customerRut: siiRut(r.rut) ?? RUT_GENERICO,
        customerActivity: r.activity ?? null,
        address: r.address ?? null,
        commune: r.commune ?? null,
        item: data ? [...new Set(data.lines.map((l) => l.productName ?? 'Producto'))].join(' + ') : 'Producto',
      };
    }
    return {
      retailerId: retailer.id,
      retailerCode: retailerCode.toUpperCase(),
      orderNumber,
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      receiptType: receipt.documentType,
      receiptDate: receipt.issuedAt,
      receiptTotal: Math.round(total),
      credited: Math.round(credited),
      available: Math.round(total - credited),
      customerName: (data?.customer.name ?? data?.shipping.name ?? '').trim() || 'Cliente',
      customerRut: siiRut(data?.customer.rut) ?? RUT_GENERICO,
      customerActivity: null as string | null,
      address: data?.shipping.address ?? null,
      commune: data?.shipping.commune ?? null,
      item: data ? [...new Set(data.lines.map((l) => l.productName ?? 'Producto'))].join(' + ') : 'Producto',
    };
  }

  private async checkAmount(p: Awaited<ReturnType<CreditNotesService['preview']>>, amount: number) {
    if (amount <= 0) throw new BadRequestException('El monto debe ser mayor a 0');
    if (amount > p.available + 0.5) {
      throw new BadRequestException(
        `La boleta N° ${p.receiptNumber} es por $${p.receiptTotal.toLocaleString('es-CL')} y ya tiene notas por $${p.credited.toLocaleString('es-CL')}: ` +
          `queda $${p.available.toLocaleString('es-CL')} por rebajar`,
      );
    }
  }

  private async linkReturn(returnId: string | null | undefined, creditNoteId: string) {
    if (!returnId) return;
    await this.db.update(productReturns).set({ creditNoteId }).where(eq(productReturns.id, returnId));
  }

  /**
   * Crea la nota en el SII según el proveedor de la empresa:
   *  - API Gateway: BORRADOR en el Portal MIPYME (después se firma en el portal)
   *  - Nubox: queda EMITIDA al tiro, con su folio
   */
  async createDraft(input: CreditNoteInput, userId: string | null) {
    await this.provider.require('notasCredito', 'hacer notas de crédito desde Cuadra');
    const p = await this.preview(input.retailerCode, input.orderNumber);
    await this.checkAmount(p, input.amountGross);
    const { providerName } = await this.provider.status();
    let draft: CreditNoteResult;
    try {
      draft = await this.provider.notaCredito({
        fecha: todayCL(),
        receptorRut: p.customerRut,
        receptorNombre: p.customerName,
        receptorDireccion: p.address,
        receptorComuna: p.commune,
        receptorGiro: p.customerActivity,
        item: `${input.refCode === 1 ? 'Anula' : 'Corrige'} ${p.receiptType === 33 ? 'factura' : 'boleta'} ${p.receiptNumber}: ${p.item}`,
        total: input.amountGross,
        boletaTipo: p.receiptType,
        boletaFolio: p.receiptNumber,
        // Boletas anotadas a mano no tienen fecha: se usa hoy como referencia
        boletaFecha: p.receiptDate ?? todayCL(),
        codRef: input.refCode,
        razon: input.reason,
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException(
        `${providerName.startsWith('Nubox') ? 'Nubox' : 'El Portal MIPYME'} rechazó la nota de crédito: ${(err as Error).message}`,
      );
    }
    const today = todayCL();
    const [row] = await this.db
      .insert(creditNotes)
      .values({
        retailerId: p.retailerId,
        orderNumber: input.orderNumber,
        receiptId: p.receiptId,
        receiptNumber: p.receiptNumber,
        receiptType: p.receiptType,
        receiptDate: p.receiptDate,
        refCode: input.refCode,
        reason: input.reason,
        amountGross: String(input.amountGross),
        ...(draft.kind === 'BORRADOR'
          ? { status: 'BORRADOR', draftCode: draft.draftCode }
          : { status: 'EMITIDA', folio: String(draft.folio), issuedAt: today }),
        siiResponse: draft.raw,
        createdBy: userId,
      })
      .returning({ id: creditNotes.id });
    await this.linkReturn(input.returnId, row.id);
    return draft.kind === 'BORRADOR'
      ? { id: row.id, draftCode: draft.draftCode, folio: null }
      : { id: row.id, draftCode: null, folio: String(draft.folio) };
  }

  /** Anotar una nota hecha fuera del ERP (folio, fecha y monto) */
  async register(input: CreditNoteInput & { folio: string; issuedAt: string }, userId: string | null) {
    const p = await this.preview(input.retailerCode, input.orderNumber);
    await this.checkAmount(p, input.amountGross);
    const [row] = await this.db
      .insert(creditNotes)
      .values({
        retailerId: p.retailerId,
        orderNumber: input.orderNumber,
        receiptId: p.receiptId,
        receiptNumber: p.receiptNumber,
        receiptType: p.receiptType,
        receiptDate: p.receiptDate,
        refCode: input.refCode,
        reason: input.reason,
        amountGross: String(input.amountGross),
        status: 'REGISTRADA',
        folio: input.folio,
        issuedAt: input.issuedAt,
        createdBy: userId,
      })
      .returning({ id: creditNotes.id });
    await this.linkReturn(input.returnId, row.id);
    return { id: row.id };
  }

  /** Después de firmarla en el portal: se anota su folio y fecha → EMITIDA */
  async confirm(id: string, data: { folio: string; issuedAt: string; notes?: string | null }) {
    const [row] = await this.db
      .update(creditNotes)
      .set({ status: 'EMITIDA', folio: data.folio, issuedAt: data.issuedAt, ...(data.notes !== undefined ? { notes: data.notes } : {}) })
      .where(and(eq(creditNotes.id, id), inArray(creditNotes.status, ['BORRADOR', 'EMITIDA', 'REGISTRADA'])))
      .returning({ id: creditNotes.id });
    if (!row) throw new NotFoundException('La nota de crédito no existe');
    return { ok: true };
  }

  /** Quitar del ERP (si es BORRADOR, también hay que borrarlo en el portal si no se va a usar) */
  async remove(id: string) {
    const [n] = await this.db.select().from(creditNotes).where(eq(creditNotes.id, id));
    if (!n) throw new NotFoundException('La nota de crédito no existe');
    if (n.status === 'EMITIDA') {
      throw new BadRequestException(`La nota N° ${n.folio} ya está emitida en el SII: no se puede quitar`);
    }
    // Si era un borrador, también se borra del Portal MIPYME (si ya no está, no importa)
    let portal: 'ELIMINADO' | 'NO_SE_PUDO' | null = null;
    if (n.status === 'BORRADOR' && n.draftCode) {
      try {
        await this.gateway.eliminarBorrador(n.draftCode);
        portal = 'ELIMINADO';
      } catch {
        portal = 'NO_SE_PUDO';
      }
    }
    await this.db.update(productReturns).set({ creditNoteId: null }).where(eq(productReturns.creditNoteId, id));
    await this.db.delete(creditNotes).where(eq(creditNotes.id, id));
    return { deleted: true, portal };
  }
}
