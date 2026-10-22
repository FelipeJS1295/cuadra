import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { productReturns, retailers } from '../database/schema/index.js';

export const RETURN_STATUSES = ['SOLICITADA', 'EN_TRANSITO', 'RECIBIDA', 'CERRADA', 'RECHAZADA'] as const;

export interface ReturnInput {
  retailerCode: string;
  orderNumber: string;
  requestedAt: string;
  scope: 'TOTAL' | 'PARCIAL';
  reason: string;
  status: (typeof RETURN_STATUSES)[number];
  receivedAt: string | null;
  productCondition: 'BUENO' | 'DANADO' | null;
  refundGross: string | null;
  reverseLogisticsCost: string | null;
  supplierAction: 'NINGUNA' | 'DEVUELTO' | 'NC_PROVEEDOR';
  supplierCreditGross: string | null;
  trackingCode: string | null;
  notes: string | null;
}

type ReturnRow = {
  id: string;
  retailer_code: string;
  retailer: string;
  order_number: string;
  order_id: string | null;
  order_date: string | null;
  product_name: string | null;
  sale_price: number | null;
  requested_at: string;
  scope: string;
  reason: string;
  status: string;
  received_at: string | null;
  product_condition: string | null;
  refund_gross: number | null;
  reverse_logistics_cost: number | null;
  supplier_action: string;
  supplier_credit_gross: number | null;
  tracking_code: string | null;
  notes: string | null;
  receipt_number: string | null;
  receipt_total: number | null;
  credit_note_id: string | null;
  credit_note_status: string | null;
  credit_note_folio: string | null;
  credit_note_amount: number | null;
  /** Cargos de logística de la liquidación de esa orden (negativos) */
  settlement_logistics: number | null;
};

const num = (v: number | null) => (v === null ? null : Math.round(v));

/**
 * Devoluciones de clientes y logística inversa.
 * Costo de la devolución = logística inversa + lo devuelto al cliente − lo que reconoce el proveedor.
 */
@Injectable()
export class ReturnsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list() {
    const { rows } = await this.db.execute<ReturnRow>(sql`
      select pr.id, r.code as retailer_code, r.name as retailer, pr.order_number,
        o.order_id, o.order_date, o.product_name, o.sale_price,
        pr.requested_at::text as requested_at, pr.scope, pr.reason, pr.status, pr.received_at::text as received_at,
        pr.product_condition, pr.refund_gross::float8 as refund_gross,
        pr.reverse_logistics_cost::float8 as reverse_logistics_cost, pr.supplier_action,
        pr.supplier_credit_gross::float8 as supplier_credit_gross, pr.tracking_code, pr.notes,
        cr.receipt_number, cr.total_gross::float8 as receipt_total,
        n.id as credit_note_id, n.status as credit_note_status, n.folio as credit_note_folio,
        n.amount_gross::float8 as credit_note_amount,
        (select sum(sr.amount_gross) from settlement_records sr
          where sr.retailer_id = pr.retailer_id and sr.order_number = pr.order_number
            and sr.kind = 'LOGISTICS' and sr.amount_gross < 0)::float8 as settlement_logistics
      from product_returns pr
      join retailers r on r.id = pr.retailer_id
      left join lateral (
        select min(s.order_id) as order_id, min(s.order_date)::text as order_date,
          string_agg(distinct s.product_name, ' + ') as product_name,
          round(sum(coalesce(s.paid_price, s.unit_price, 0) * s.quantity
            * case when s.amounts_include_tax then 1 else 1.19 end))::float8 as sale_price
        from sales_records s where s.retailer_id = pr.retailer_id and s.order_number = pr.order_number
      ) o on true
      left join customer_receipts cr on cr.retailer_id = pr.retailer_id and cr.order_number = pr.order_number
      left join credit_notes n on n.id = pr.credit_note_id
      order by pr.requested_at desc, pr.created_at desc
    `);
    return rows.map((r) => {
      const logistics = r.reverse_logistics_cost ?? 0;
      const refund = r.refund_gross ?? 0;
      const supplier = r.supplier_credit_gross ?? 0;
      return {
        id: r.id,
        retailerCode: r.retailer_code,
        retailer: r.retailer,
        orderNumber: r.order_number,
        orderId: r.order_id,
        orderDate: r.order_date,
        productName: r.product_name,
        salePrice: num(r.sale_price),
        requestedAt: r.requested_at,
        scope: r.scope,
        reason: r.reason,
        status: r.status,
        receivedAt: r.received_at,
        productCondition: r.product_condition,
        refundGross: num(r.refund_gross),
        reverseLogisticsCost: num(r.reverse_logistics_cost),
        supplierAction: r.supplier_action,
        supplierCreditGross: num(r.supplier_credit_gross),
        trackingCode: r.tracking_code,
        notes: r.notes,
        receipt: r.receipt_number ? { number: r.receipt_number, totalGross: Math.round(r.receipt_total ?? 0) } : null,
        creditNote: r.credit_note_id
          ? { id: r.credit_note_id, status: r.credit_note_status!, folio: r.credit_note_folio, amountGross: Math.round(r.credit_note_amount ?? 0) }
          : null,
        /** Cargos de logística que ya trae la liquidación del retailer para esa orden (positivo) */
        settlementLogistics: r.settlement_logistics !== null ? Math.round(-r.settlement_logistics) : null,
        /** Lo que le cuesta la devolución a la empresa */
        netCost: Math.round(logistics + refund - supplier),
      };
    });
  }

  private async retailerId(code: string) {
    const [r] = await this.db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, code.toUpperCase()));
    if (!r) throw new BadRequestException(`Retailer "${code}" no existe`);
    return r.id;
  }

  async create(input: ReturnInput, userId: string | null) {
    const retailerId = await this.retailerId(input.retailerCode);
    const { rows } = await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sales_records where retailer_id = ${retailerId} and order_number = ${input.orderNumber}`,
    );
    if (!rows[0].n) throw new BadRequestException(`No existe la orden ${input.orderNumber} en ${input.retailerCode}`);
    const { retailerCode: _code, ...data } = input;
    const [row] = await this.db
      .insert(productReturns)
      .values({ ...data, retailerId, createdBy: userId })
      .returning({ id: productReturns.id });
    return row;
  }

  async update(id: string, changes: Partial<Omit<ReturnInput, 'retailerCode' | 'orderNumber'>>) {
    const [row] = await this.db.update(productReturns).set(changes).where(eq(productReturns.id, id)).returning({ id: productReturns.id });
    if (!row) throw new NotFoundException('La devolución no existe');
    return row;
  }

  async remove(id: string) {
    const [row] = await this.db.delete(productReturns).where(and(eq(productReturns.id, id))).returning({ id: productReturns.id });
    if (!row) throw new NotFoundException('La devolución no existe');
    return { deleted: true };
  }
}
