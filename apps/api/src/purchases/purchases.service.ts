import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PRICING_CHANNELS } from '@cuadra/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import {
  purchaseDocumentLines,
  purchaseDocumentPayments,
  purchaseDocuments,
  retailers,
  suppliers,
} from '../database/schema/index.js';

/** Notas de crédito (restan) */
const isCreditNoteType = (type: number) => type === 60 || type === 61;

/** IVA Chile */
export const VAT_RATE = 1.19;

export interface NewDocumentInput {
  supplier: string;
  documentNumber: string;
  /** Fecha de la factura (AAAA-MM-DD). Si no viene, hoy */
  issueDate?: string | null;
  /** Opción de conciliación (ej: CENCOSUD, CENCOSUD_FULFILLMENT, FALABELLA) */
  retailerCode: string;
  lines: { itemKey: string; orderNumber: string | null; productName: string | null; amountNet: string }[];
}

/** Documento de compra ligado a una fila de la conciliación */
export interface RowDocument {
  lineId: string;
  documentId: string;
  documentNumber: string;
  supplier: string;
  amountNet: number;
  amountGross: number;
}

/** Factura del proveedor con sus totales y lo pagado */
export interface PurchaseInvoice {
  id: string;
  supplierId: string;
  supplier: string;
  documentNumber: string;
  /** Clientes (retailers) de las órdenes de la factura. Ej: ["Falabella"] */
  clients: string[];
  /** Fecha en que se ingresó (AAAA-MM-DD) */
  createdAt: string;
  /** Fecha de emisión de la factura (AAAA-MM-DD): mes del IVA crédito */
  issueDate: string;
  orders: number;
  net: number;
  vat: number;
  /** Total con IVA */
  total: number;
  paid: number;
  /** Lo que falta pagar */
  balance: number;
  status: 'PENDIENTE' | 'PARCIAL' | 'PAGADA' | 'NOTA_CREDITO';
  lastPaymentAt: string | null;
  /** Tipo SII: 33 factura, 34 exenta, 61 nota de crédito… */
  documentType: number;
  supplierRut: string | null;
  /** Traída del Registro de Compras del SII (los montos son los del SII) */
  fromSii: boolean;
  /** Estado en el RCV (REGISTRO, PENDIENTE…) */
  siiStatus: string | null;
  /** Neto asignado a órdenes (para ver cuánto falta asignar) */
  assignedNet: number;
}

export interface PurchaseInvoiceDetail extends PurchaseInvoice {
  lines: {
    id: string;
    retailer: string;
    orderNumber: string | null;
    productName: string | null;
    net: number;
    total: number;
  }[];
  payments: {
    id: string;
    amount: number;
    paidAt: string;
    method: string | null;
    note: string | null;
    createdBy: string | null;
  }[];
}

const RETAILER_LABELS: Record<string, string> = Object.fromEntries(
  PRICING_CHANNELS.map((c) => [c.code, c.label]),
);

/** Retailer en la base a partir de la opción de conciliación (CENCOSUD_FULFILLMENT -> CENCOSUD) */
const baseRetailerCode = (code: string) => code.toUpperCase().replace(/_FULFILLMENT$/, '');

@Injectable()
export class PurchasesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Proveedores ya usados (para sugerirlos al escribir) */
  listSuppliers() {
    return this.db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .orderBy(asc(suppliers.name));
  }

  /**
   * Guarda un documento con sus líneas (una por orden).
   * - El proveedor se crea si no existe (sin importar mayúsculas).
   * - Si el mismo proveedor ya tiene ese N° de documento, las órdenes se agregan a ese
   *   documento; si una orden ya estaba en él, se actualiza su monto.
   */
  async createDocument(input: NewDocumentInput, userId: string | null) {
    const [retailer] = await this.db
      .select({ id: retailers.id })
      .from(retailers)
      .where(eq(retailers.code, baseRetailerCode(input.retailerCode)));
    if (!retailer) throw new BadRequestException(`Retailer "${input.retailerCode}" no existe`);

    return this.db.transaction(async (tx) => {
      // Proveedor (lo crea si es nuevo)
      await tx
        .insert(suppliers)
        .values({ name: input.supplier })
        .onConflictDoNothing();
      const [supplier] = await tx
        .select()
        .from(suppliers)
        .where(sql`lower(${suppliers.name}) = lower(${input.supplier})`);

      // Documento (lo reutiliza si ya existe para ese proveedor)
      await tx
        .insert(purchaseDocuments)
        .values({
          supplierId: supplier.id,
          documentNumber: input.documentNumber,
          issueDate: input.issueDate ?? sql`(now() at time zone 'America/Santiago')::date`,
          createdBy: userId,
        })
        .onConflictDoNothing();
      const [document] = await tx
        .select()
        .from(purchaseDocuments)
        .where(
          and(
            eq(purchaseDocuments.supplierId, supplier.id),
            eq(purchaseDocuments.documentType, 33),
            eq(purchaseDocuments.documentNumber, input.documentNumber),
          ),
        );

      // Líneas: una por orden; si la orden ya estaba en este documento, se actualiza el monto
      await tx
        .insert(purchaseDocumentLines)
        .values(
          input.lines.map((l) => ({
            documentId: document.id,
            retailerId: retailer.id,
            itemKey: l.itemKey,
            orderNumber: l.orderNumber,
            productName: l.productName,
            amountNet: l.amountNet,
          })),
        )
        .onConflictDoUpdate({
          target: [purchaseDocumentLines.documentId, purchaseDocumentLines.retailerId, purchaseDocumentLines.itemKey],
          set: { amountNet: sql`excluded.amount_net`, productName: sql`excluded.product_name` },
        });

      return {
        documentId: document.id,
        supplier: supplier.name,
        documentNumber: document.documentNumber,
        lines: input.lines.length,
      };
    });
  }

  /** Quita una orden de un documento; si el documento queda sin órdenes, se elimina */
  async deleteLine(lineId: string) {
    return this.db.transaction(async (tx) => {
      const [line] = await tx
        .delete(purchaseDocumentLines)
        .where(eq(purchaseDocumentLines.id, lineId))
        .returning({ documentId: purchaseDocumentLines.documentId });
      if (!line) throw new NotFoundException('La orden ya no está en ese documento');

      const [{ remaining }] = await tx
        .select({ remaining: sql<number>`count(*)::int` })
        .from(purchaseDocumentLines)
        .where(eq(purchaseDocumentLines.documentId, line.documentId));
      const [doc] = await tx
        .select({ fromSii: sql<boolean>`${purchaseDocuments.siiImportedAt} is not null` })
        .from(purchaseDocuments)
        .where(eq(purchaseDocuments.id, line.documentId));
      // Las traídas del SII se quedan aunque no tengan órdenes
      if (remaining === 0 && !doc?.fromSii) {
        // Si la factura ya tiene pagos, no se puede quedar sin órdenes (se perderían los pagos)
        const [{ payments }] = await tx
          .select({ payments: sql<number>`count(*)::int` })
          .from(purchaseDocumentPayments)
          .where(eq(purchaseDocumentPayments.documentId, line.documentId));
        if (payments > 0) {
          throw new BadRequestException(
            'Es la última orden de una factura que ya tiene pagos. Elimina primero los pagos en Facturas.',
          );
        }
        await tx.delete(purchaseDocuments).where(eq(purchaseDocuments.id, line.documentId));
      }
      return { deleted: true, documentDeleted: remaining === 0 && !doc?.fromSii };
    });
  }

  /** Todas las facturas de proveedores con su total, lo pagado y el saldo (las más nuevas primero) */
  async listInvoices(): Promise<PurchaseInvoice[]> {
    const { rows } = await this.db.execute<{
      id: string;
      supplier_id: string;
      supplier: string;
      document_number: string;
      client_codes: string[] | null;
      client_names: string[] | null;
      created_at: string;
      issue_date: string;
      orders: number;
      net: number;
      total: number;
      paid: number;
      last_payment_at: string | null;
      document_type: number;
      tax_id: string | null;
      sii_total: number | null;
      sii_net: number | null;
      sii_exempt: number | null;
      sii_vat: number | null;
      sii_status: string | null;
    }>(sql`
      select
        d.id, d.supplier_id, s.name as supplier, d.document_number, d.document_type, s.tax_id,
        d.sii_total::float8 as sii_total, d.sii_net::float8 as sii_net, d.sii_exempt::float8 as sii_exempt,
        d.sii_vat::float8 as sii_vat, d.sii_status,
        (d.created_at at time zone 'America/Santiago')::date::text as created_at,
        coalesce(d.issue_date, (d.created_at at time zone 'America/Santiago')::date)::text as issue_date,
        l.client_codes, l.client_names,
        coalesce(l.orders, 0)::int as orders,
        coalesce(l.net, 0)::float8 as net,
        coalesce(l.total, 0)::float8 as total,
        coalesce(p.paid, 0)::float8 as paid,
        p.last_payment_at::text as last_payment_at
      from purchase_documents d
      join suppliers s on s.id = d.supplier_id
      left join lateral (
          select count(*) as orders, sum(amount_net) as net,
          -- Cliente = retailer de las órdenes de la factura
          array_agg(distinct r.code) as client_codes,
          array_agg(distinct r.name) as client_names,
          -- con IVA por línea, redondeado igual que en la conciliación
          sum(round(amount_net * ${sql.raw(String(VAT_RATE))})) as total
        from purchase_document_lines pl
        join retailers r on r.id = pl.retailer_id
        where pl.document_id = d.id
      ) l on true
      left join lateral (
        select sum(amount) as paid, max(paid_at) as last_payment_at
        from purchase_document_payments where document_id = d.id
      ) p on true
      -- Las facturas de retailers (comisiones) no son deuda con proveedores
      where d.retailer_id is null
      order by d.created_at desc
    `);
    return rows.map((r) => {
      // Con datos del SII mandan sus montos; si no, la suma de las órdenes asignadas
      const fromSii = r.sii_total !== null;
      const sign = isCreditNoteType(r.document_type) ? -1 : 1;
      const net = sign * Math.round(fromSii ? (r.sii_net ?? 0) + (r.sii_exempt ?? 0) : r.net);
      const total = sign * Math.round(fromSii ? r.sii_total! : r.total);
      const vat = fromSii ? sign * Math.round(r.sii_vat ?? 0) : total - net;
      const paid = Math.round(r.paid);
      const balance = total - paid;
      return {
        id: r.id,
        supplierId: r.supplier_id,
        supplier: r.supplier,
        documentNumber: r.document_number,
        clients: (r.client_codes ?? []).map((code, i) => RETAILER_LABELS[code] ?? r.client_names?.[i] ?? code),
        createdAt: r.created_at,
        issueDate: r.issue_date,
        orders: r.orders,
        net,
        vat,
        total,
        paid,
        balance,
        status: sign < 0 ? 'NOTA_CREDITO' : total > 0 && paid <= 0 ? 'PENDIENTE' : balance > 0 ? 'PARCIAL' : 'PAGADA',
        lastPaymentAt: r.last_payment_at,
        documentType: r.document_type,
        supplierRut: r.tax_id,
        fromSii,
        siiStatus: r.sii_status,
        assignedNet: Math.round(r.net),
      };
    });
  }

  /** Cambia la fecha de emisión de una factura (define su mes en el resumen de IVA) */
  async setIssueDate(id: string, issueDate: string) {
    const [row] = await this.db
      .update(purchaseDocuments)
      .set({ issueDate })
      .where(eq(purchaseDocuments.id, id))
      .returning({ id: purchaseDocuments.id });
    if (!row) throw new NotFoundException('La factura no existe');
    return { ok: true };
  }

  /** Una factura con sus órdenes y sus pagos */
  async getInvoice(id: string): Promise<PurchaseInvoiceDetail> {
    const invoice = (await this.listInvoices()).find((i) => i.id === id);
    if (!invoice) throw new NotFoundException('La factura no existe');

    const [lines, payments] = await Promise.all([
      this.db
        .select({
          id: purchaseDocumentLines.id,
          retailerCode: retailers.code,
          retailerName: retailers.name,
          orderNumber: purchaseDocumentLines.orderNumber,
          productName: purchaseDocumentLines.productName,
          amountNet: purchaseDocumentLines.amountNet,
        })
        .from(purchaseDocumentLines)
        .innerJoin(retailers, eq(retailers.id, purchaseDocumentLines.retailerId))
        .where(eq(purchaseDocumentLines.documentId, id))
        .orderBy(asc(purchaseDocumentLines.createdAt)),
      this.db.execute<{
        id: string;
        amount: number;
        paid_at: string;
        method: string | null;
        note: string | null;
        created_by: string | null;
      }>(sql`
        select p.id, p.amount::float8 as amount, p.paid_at::text as paid_at, p.method, p.note,
          u.name as created_by
        from purchase_document_payments p
        left join users u on u.id = p.created_by
        where p.document_id = ${id}
        order by p.paid_at, p.created_at
      `),
    ]);

    return {
      ...invoice,
      lines: lines.map((l) => {
        const net = Number(l.amountNet);
        return {
          id: l.id,
          retailer: RETAILER_LABELS[l.retailerCode] ?? l.retailerName,
          orderNumber: l.orderNumber,
          productName: l.productName,
          net: Math.round(net),
          total: Math.round(net * VAT_RATE),
        };
      }),
      payments: payments.rows.map((p) => ({
        id: p.id,
        amount: Math.round(p.amount),
        paidAt: p.paid_at,
        method: p.method,
        note: p.note,
        createdBy: p.created_by,
      })),
    };
  }

  /** Registra un pago (abono) a una factura. No puede ser mayor a lo que falta pagar */
  async addPayment(
    documentId: string,
    input: { amount: string; paidAt: string; method: string | null; note: string | null },
    userId: string | null,
  ) {
    const invoice = (await this.listInvoices()).find((i) => i.id === documentId);
    if (!invoice) throw new NotFoundException('La factura no existe');
    const amount = Number(input.amount);
    if (amount > invoice.balance + 0.5) {
      throw new BadRequestException(
        `El pago ($${Math.round(amount).toLocaleString('es-CL')}) es mayor a lo que falta pagar ($${invoice.balance.toLocaleString('es-CL')})`,
      );
    }
    const [row] = await this.db
      .insert(purchaseDocumentPayments)
      .values({
        documentId,
        amount: input.amount,
        paidAt: input.paidAt,
        method: input.method,
        note: input.note,
        createdBy: userId,
      })
      .returning({ id: purchaseDocumentPayments.id });
    return row;
  }

  async deletePayment(id: string) {
    const [row] = await this.db
      .delete(purchaseDocumentPayments)
      .where(eq(purchaseDocumentPayments.id, id))
      .returning({ id: purchaseDocumentPayments.id });
    if (!row) throw new NotFoundException('El pago ya no existe');
    return { deleted: true };
  }

  /** Documentos de las filas de la conciliación de un retailer, agrupados por clave de fila */
  async documentsByItem(retailerId: string, itemKeys: string[]): Promise<Map<string, RowDocument[]>> {
    const map = new Map<string, RowDocument[]>();
    if (itemKeys.length === 0) return map;
    const rows = await this.db
      .select({
        itemKey: purchaseDocumentLines.itemKey,
        lineId: purchaseDocumentLines.id,
        documentId: purchaseDocuments.id,
        documentNumber: purchaseDocuments.documentNumber,
        supplier: suppliers.name,
        amountNet: purchaseDocumentLines.amountNet,
      })
      .from(purchaseDocumentLines)
      .innerJoin(purchaseDocuments, eq(purchaseDocuments.id, purchaseDocumentLines.documentId))
      .innerJoin(suppliers, eq(suppliers.id, purchaseDocuments.supplierId))
      .where(
        and(eq(purchaseDocumentLines.retailerId, retailerId), inArray(purchaseDocumentLines.itemKey, itemKeys)),
      )
      .orderBy(asc(purchaseDocuments.createdAt));

    for (const r of rows) {
      const net = Number(r.amountNet);
      const list = map.get(r.itemKey) ?? [];
      list.push({
        lineId: r.lineId,
        documentId: r.documentId,
        documentNumber: r.documentNumber,
        supplier: r.supplier,
        amountNet: net,
        amountGross: Math.round(net * VAT_RATE),
      });
      map.set(r.itemKey, list);
    }
    return map;
  }
}