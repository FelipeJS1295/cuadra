import { CANCELLED_PATTERN } from '@cuadra/shared';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';

const VAT = 0.19;
/** IVA contenido en un monto con IVA */
const vatOf = (gross: number) => Math.round(gross - gross / (1 + VAT));

type DocRow = {
  month: string;
  date: string | null;
  kind: string;
  retailer: string | null;
  reference: string;
  description: string | null;
  gross: number;
  vat: number;
};

export interface VatMonth {
  month: string;
  /** IVA de las boletas del mes */
  debitReceipts: number;
  /** IVA de las notas de crédito del mes (rebaja el débito) */
  debitCreditNotes: number;
  debit: number;
  creditPurchases: number;
  creditCommissions: number;
  creditLogistics: number;
  credit: number;
  /** IVA a pagar (si es negativo, queda remanente) */
  balance: number;
  /** Ventas del mes sin boleta (no están en el débito) */
  salesWithoutReceipt: number;
  salesWithoutReceiptVat: number;
  draftCreditNotes: number;
  /** IVA de las facturas de retailers traídas del SII (null si no hay): debería parecerse a comisiones + logística */
  retailerInvoicesVat: number | null;
}

/**
 * Resumen de IVA por mes, con la FECHA DE CADA DOCUMENTO (como el F29):
 *  Débito  = IVA de las boletas (fecha de emisión; las anotadas a mano sin fecha usan la fecha de la orden)
 *          − IVA de las notas de crédito emitidas/anotadas (su fecha)
 *  Crédito = IVA de las facturas de proveedores (fecha de la factura)
 *          + IVA de comisiones (fecha del movimiento en la liquidación)
 *          + IVA de cargos de envío y logística (fecha del movimiento)
 *  A pagar = Débito − Crédito
 */
@Injectable()
export class VatService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Todos los documentos con IVA, con su mes */
  private async documents(fromMonth: string, toMonth: string): Promise<DocRow[]> {
    const from = `${fromMonth}-01`;
    const to = `${toMonth}-01`;
    const { rows } = await this.db.execute<DocRow>(sql`
      with docs as (
        -- Boletas
        select coalesce(cr.issued_at, o.order_date) as date, 'BOLETA' as kind, r.name as retailer,
          cr.receipt_number as reference, cr.order_number as description, cr.total_gross as gross, null::numeric as tax
        from customer_receipts cr
        join retailers r on r.id = cr.retailer_id
        left join lateral (select min(order_date) as order_date from sales_records s
          where s.retailer_id = cr.retailer_id and s.order_number = cr.order_number) o on true
        where cr.status in ('EMITIDA', 'REGISTRADA')
        union all
        -- Notas de crédito (restan)
        select n.issued_at, 'NOTA_CREDITO', r.name, n.folio, n.order_number, -n.amount_gross, null
        from credit_notes n join retailers r on r.id = n.retailer_id
        where n.status in ('EMITIDA', 'REGISTRADA')
        union all
        -- Facturas de proveedores: montos del SII si se trajeron del RCV; si no, neto de las órdenes -> con IVA.
        -- Las notas de crédito del proveedor (60/61) restan.
        select coalesce(d.issue_date, (d.created_at at time zone 'America/Santiago')::date), 'COMPRA', sp.name,
          d.document_number,
          case when d.document_type in (60, 61) then 'Nota de crédito' when d.document_type = 34 then 'Exenta' end,
          (case when d.document_type in (60, 61) then -1 else 1 end) * coalesce(d.sii_total, round(l.net * 1.19)),
          (case when d.document_type in (60, 61) then -1 else 1 end) * coalesce(d.sii_vat, round(l.net * 0.19))
        from purchase_documents d
        join suppliers sp on sp.id = d.supplier_id
        left join lateral (select sum(amount_net) as net from purchase_document_lines pl where pl.document_id = d.id) l on true
        where d.retailer_id is null and (d.sii_total is not null or l.net is not null)
        union all
        -- Facturas que emitió un retailer (comisiones, logística): solo para cuadrar con las
        -- liquidaciones; su IVA ya entra por COMISION / LOGISTICA y no se suma de nuevo
        select coalesce(d.issue_date, (d.created_at at time zone 'America/Santiago')::date), 'FACTURA_RETAILER', r.name,
          d.document_number,
          case when d.document_type in (60, 61) then 'Nota de crédito' end,
          (case when d.document_type in (60, 61) then -1 else 1 end) * d.sii_total,
          (case when d.document_type in (60, 61) then -1 else 1 end) * d.sii_vat
        from purchase_documents d
        join retailers r on r.id = d.retailer_id
        where d.sii_total is not null
        union all
        -- Comisiones y cargos de envío/logística cobrados en las liquidaciones (negativos)
        select sr.transaction_date,
          case when sr.kind = 'COMMISSION' then 'COMISION' else 'LOGISTICA' end,
          r.name, coalesce(sr.statement_number, sr.order_number, '—'), sr.order_number,
          -sr.amount_gross, -sr.tax_amount
        from settlement_records sr join retailers r on r.id = sr.retailer_id
        where sr.kind in ('COMMISSION', 'SHIPPING', 'LOGISTICS') and sr.amount_gross < 0
      )
      select to_char(date, 'YYYY-MM') as month, date::text as date, kind, retailer, reference, description,
        gross::float8 as gross, coalesce(tax, 0)::float8 as vat
      from docs
      where date >= ${from}::date and date < (${to}::date + interval '1 month')
      order by date, kind
    `);
    // IVA: el informado en el documento o, si no viene, el contenido en el monto con IVA
    return rows.map((d) => ({ ...d, vat: d.vat ? Math.round(d.vat) : d.kind === 'NOTA_CREDITO' ? -vatOf(-d.gross) : vatOf(d.gross) }));
  }

  async months(count = 12) {
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date()).slice(0, 7);
    const [y, m] = now.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - count, 1)).toISOString().slice(0, 7);
    const [docs, { rows: pending }] = await Promise.all([
      this.documents(start, now),
      this.db.execute<{ month: string; gross: number; drafts: number }>(sql`
        select to_char(o.order_date, 'YYYY-MM') as month, sum(o.gross)::float8 as gross, 0 as drafts
        from (
          select s.retailer_id, s.order_number, min(s.order_date) as order_date,
            sum(coalesce(s.paid_price, s.unit_price, 0) * s.quantity * case when s.amounts_include_tax then 1 else 1.19 end) as gross
          from sales_records s
          group by 1, 2
          having not bool_and(coalesce(s.status, '') ~* ${CANCELLED_PATTERN})
        ) o
        where not exists (select 1 from customer_receipts cr where cr.retailer_id = o.retailer_id and cr.order_number = o.order_number)
          and o.order_date >= ${`${start}-01`}::date
        group by 1
        union all
        select to_char(created_at at time zone 'America/Santiago', 'YYYY-MM'), 0, count(*)
        from credit_notes where status = 'BORRADOR' group by 1
      `),
    ]);

    const months: VatMonth[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const month = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
      const d = docs.filter((x) => x.month === month);
      const sum = (kind: string) => d.filter((x) => x.kind === kind).reduce((n, x) => n + x.vat, 0);
      const debitReceipts = sum('BOLETA');
      const debitCreditNotes = sum('NOTA_CREDITO');
      const creditPurchases = sum('COMPRA');
      const creditCommissions = sum('COMISION');
      const creditLogistics = sum('LOGISTICA');
      const retailerDocs = d.filter((x) => x.kind === 'FACTURA_RETAILER');
      const debit = debitReceipts + debitCreditNotes;
      const credit = creditPurchases + creditCommissions + creditLogistics;
      const p = pending.filter((x) => x.month === month);
      const salesWithoutReceipt = Math.round(p.reduce((n, x) => n + x.gross, 0));
      months.push({
        month,
        debitReceipts,
        debitCreditNotes,
        debit,
        creditPurchases,
        creditCommissions,
        creditLogistics,
        credit,
        balance: debit - credit,
        salesWithoutReceipt,
        salesWithoutReceiptVat: vatOf(salesWithoutReceipt),
        draftCreditNotes: p.reduce((n, x) => n + Number(x.drafts), 0),
        // IVA de las facturas de los retailers según el SII (para comparar con comisiones + logística)
        retailerInvoicesVat: retailerDocs.length ? retailerDocs.reduce((n, x) => n + x.vat, 0) : null,
      });
    }
    return months.reverse();
  }

  /** Documentos de un mes (detalle del resumen) */
  async detail(month: string) {
    return (await this.documents(month, month)).map((d) => ({
      date: d.date,
      kind: d.kind,
      retailer: d.retailer,
      reference: d.reference,
      description: d.description,
      gross: Math.round(d.gross),
      vat: d.vat,
    }));
  }

  /** Detalle del mes en CSV (Excel lo abre directo) */
  async csv(month: string) {
    const labels: Record<string, string> = {
      BOLETA: 'Boleta (débito)',
      NOTA_CREDITO: 'Nota de crédito (rebaja débito)',
      COMPRA: 'Factura proveedor (crédito)',
      COMISION: 'Comisión retailer (crédito)',
      LOGISTICA: 'Envío/logística retailer (crédito)',
      FACTURA_RETAILER: 'Factura del retailer (referencia, no suma)',
    };
    const rows = await this.detail(month);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      ['Fecha', 'Tipo', 'Retailer / Proveedor', 'N° documento', 'Orden', 'Total con IVA', 'IVA'].join(';'),
      ...rows.map((r) =>
        [r.date, labels[r.kind] ?? r.kind, r.retailer, r.reference, r.description, r.gross, r.vat].map(esc).join(';'),
      ),
    ];
    return '﻿' + lines.join('\n') + '\n';
  }
}
