import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { orderStateOfLines, PRICING_CHANNELS } from '@cuadra/shared';
import { productReturns, retailers } from '../database/schema/index.js';
import { courierOf } from '../sales/sales.service.js';

/**
 * Candidatos a N° de orden o seguimiento dentro de un texto leído por OCR: cada número de 6 o
 * más caracteres, y los números vecinos de una misma línea unidos (el OCR separa los dígitos
 * espaciados). Los más largos primero.
 */
export function textCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.match(/[A-Za-z0-9-]+/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].replace(/^-+|-+$/g, '');
      if (t.length >= 6 && /\d/.test(t)) out.add(t);
      let joined = t;
      for (let j = i + 1; j < Math.min(tokens.length, i + 3) && /^\d+$/.test(joined) && /^\d+$/.test(tokens[j]); j++) {
        joined += tokens[j];
        if (joined.length >= 8 && joined.length <= 20) out.add(joined);
      }
    }
  }
  return [...out]
    .filter((c) => c.length <= 40)
    .sort((a, b) => b.length - a.length)
    .slice(0, 25);
}

const LABELS: Record<string, string> = Object.fromEntries(PRICING_CHANNELS.map((c) => [c.code, c.label]));
/** Escapa % y _ para usar el código en un LIKE */
const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const reSafe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Orden encontrada al escanear el código de una devolución */
export interface ScannedOrder {
  retailerCode: string;
  retailer: string;
  orderNumber: string;
  orderDate: string | null;
  dispatchDeadline: string | null;
  deliveredAt: string | null;
  customer: string | null;
  commune: string | null;
  courier: string | null;
  tracking: string | null;
  state: string;
  /** Por qué calzó: N° de orden, seguimiento o un código dentro de los datos de la orden */
  matchedBy: string;
  lines: { saleId: string; product: string; retailName: string | null; parentSku: string | null; sku: string | null; quantity: number }[];
  /** Devolución ya registrada para esta orden */
  existing: { id: string; status: string; receivedAt: string | null; productCondition: string | null } | null;
}

export interface ReceiveInput {
  retailerCode: string;
  orderNumber: string;
  code: string;
  scope: 'TOTAL' | 'PARCIAL';
  products: string[];
  productCondition: 'BUENO' | 'DANADO';
  reason: string;
  notes: string | null;
}

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

  /**
   * Busca la venta de un código escaneado: N° de orden o sub-orden, código de seguimiento, o
   * cualquier código que venga en los datos de la orden (bulto, guía del courier…).
   */
  /**
   * Números leídos con la cámara (OCR) de la etiqueta: se arman candidatos (cada número, y los
   * que vienen separados por espacios como "4792638001 690") y se busca la orden con cada uno.
   * Ej.: la etiqueta de devolución de Walmart trae la OC en "REFERENCIA" y su código de barras
   * es la guía de Bluexpress.
   */
  async lookupText(text: string): Promise<{ code: string; candidates: string[]; orders: ScannedOrder[] }> {
    const candidates = textCandidates(text);
    const orders = new Map<string, ScannedOrder>();
    let code = '';
    for (const c of candidates) {
      const r = await this.lookup(c, false);
      for (const o of r.orders) {
        const key = `${o.retailerCode}|${o.orderNumber}`;
        if (!orders.has(key)) orders.set(key, { ...o, matchedBy: `número leído ${c}` });
        code ||= c;
      }
      if (orders.size >= 5) break;
    }
    return { code: code || candidates[0] || '', candidates, orders: [...orders.values()] };
  }

  async lookup(rawCode: string, deep = true): Promise<{ code: string; orders: ScannedOrder[] }> {
    const code = rawCode.trim().replace(/\s+/g, '');
    if (code.length < 4) throw new BadRequestException('El código es muy corto');
    if (code.length > 120) throw new BadRequestException('El código es muy largo');
    const up = code.toUpperCase();
    const quoted = `%"${likeSafe(code)}"%`;
    const sub = `${likeSafe(up)}-%`;
    // Número dentro del JSON de la orden (ej: "trackingNumber": 123456789)
    const numeric = /^\d+$/.test(code) ? `[:\\[,] ?${reSafe(code)}[,}\\]]` : null;

    const { rows } = await this.db.execute<{
      id: string;
      code: string;
      name: string;
      order_number: string | null;
      tracking_code: string | null;
      order_date: string | null;
      dispatch_deadline: string | null;
      delivered_at: string | null;
      customer: string | null;
      commune: string | null;
      carrier: string | null;
      product: string | null;
      own_name: string | null;
      parent_sku: string | null;
      sku: string | null;
      quantity: number;
      status: string | null;
      matched_by: string;
    }>(sql`
      with api_hits as (
        select o.id::text as id
        from retail_api_orders o
        where o.order_date >= now() - interval '400 days'
          and (upper(o.order_number) = ${up} or upper(o.customer_order_id) = ${up} or upper(o.external_id) = ${up}
               ${deep ? sql`or o.raw::text ilike ${quoted}` : sql``}
               ${deep && numeric ? sql`or o.raw::text ~ ${numeric}` : sql``})
        limit 20
      )
      select s.id, r.code, r.name, s.order_number, s.tracking_code,
        s.order_date::date::text as order_date, s.dispatch_deadline::text as dispatch_deadline, s.delivered_at::text as delivered_at,
        coalesce(s.customer_name, s.shipping_name) as customer, s.shipping_commune as commune, s.carrier,
        s.product_name as product, sn.name as own_name, sn.parent_sku, s.seller_sku as sku, s.quantity, s.status,
        case
          when upper(s.order_number) = ${up} or upper(s.order_id) = ${up} or upper(s.order_number) like ${sub} then 'N° de orden'
          when upper(s.tracking_code) = ${up} then 'Código de seguimiento'
          else 'Código del paquete'
        end as matched_by
      from sales_records s
      join retailers r on r.id = s.retailer_id
      left join retail_sku_names sn on sn.provider = r.code and sn.seller_sku = upper(s.seller_sku)
      where s.order_date >= now() - interval '400 days'
        and (upper(s.order_number) = ${up} or upper(s.order_id) = ${up} or upper(s.tracking_code) = ${up}
             or upper(s.external_item_id) = ${up}
             or upper(s.order_number) like ${sub}
             or s.raw->>'apiOrderId' in (select id from api_hits)
             ${deep ? sql`or s.raw::text ilike ${quoted}` : sql``})
      order by s.order_date desc, s.order_number
      limit 60
    `);

    const groups = new Map<string, ScannedOrder & { statuses: (string | null)[] }>();
    for (const r of rows) {
      const key = `${r.code}|${r.order_number ?? r.id}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          retailerCode: r.code,
          retailer: LABELS[r.code] ?? r.name,
          orderNumber: r.order_number ?? '—',
          orderDate: r.order_date,
          dispatchDeadline: r.dispatch_deadline,
          deliveredAt: r.delivered_at,
          customer: r.customer,
          commune: r.commune,
          courier: courierOf(r.code, r.carrier) ?? r.carrier,
          tracking: r.tracking_code,
          state: '',
          matchedBy: r.matched_by,
          lines: [],
          existing: null,
          statuses: [],
        };
        groups.set(key, g);
      }
      g.statuses.push(r.status);
      g.lines.push({
        saleId: r.id,
        product: (r.own_name ?? r.product ?? r.sku ?? 'Producto').trim(),
        retailName: r.own_name ? r.product : null,
        parentSku: r.parent_sku,
        sku: r.sku,
        quantity: Number(r.quantity) || 1,
      });
    }
    const orders = [...groups.values()].map(({ statuses, ...g }) => ({ ...g, state: orderStateOfLines(statuses) }));

    // Devolución ya registrada de cada orden (la más reciente)
    if (orders.length) {
      const { rows: prev } = await this.db.execute<{
        id: string;
        code: string;
        order_number: string;
        status: string;
        received_at: string | null;
        product_condition: string | null;
      }>(sql`
        select distinct on (r.code, pr.order_number) pr.id, r.code, pr.order_number, pr.status, pr.received_at::text as received_at, pr.product_condition
        from product_returns pr join retailers r on r.id = pr.retailer_id
        where pr.order_number in ${orders.map((o) => o.orderNumber)}
        order by r.code, pr.order_number, pr.created_at desc
      `);
      for (const o of orders) {
        const p = prev.find((x) => x.code === o.retailerCode && x.order_number === o.orderNumber);
        if (p) o.existing = { id: p.id, status: p.status, receivedAt: p.received_at, productCondition: p.product_condition };
      }
    }
    return { code, orders };
  }

  /**
   * Marca la devolución como recibida en bodega. Si la orden ya tenía una devolución abierta
   * (solicitada o en tránsito) se actualiza; si no, se crea.
   */
  async receive(input: ReceiveInput, userId: string | null) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const retailerId = await this.retailerId(input.retailerCode);
    const detail = [
      input.scope === 'PARCIAL' && input.products.length ? `Productos recibidos: ${input.products.join(', ')}` : null,
      `Escaneado: ${input.code}`,
      input.notes,
    ]
      .filter(Boolean)
      .join('\n');
    const [open] = await this.db
      .select({ id: productReturns.id, notes: productReturns.notes, trackingCode: productReturns.trackingCode })
      .from(productReturns)
      .where(
        and(
          eq(productReturns.retailerId, retailerId),
          eq(productReturns.orderNumber, input.orderNumber),
          sql`${productReturns.status} in ('SOLICITADA', 'EN_TRANSITO')`,
        ),
      )
      .limit(1);
    if (open) {
      await this.db
        .update(productReturns)
        .set({
          status: 'RECIBIDA',
          receivedAt: today,
          productCondition: input.productCondition,
          scope: input.scope,
          trackingCode: open.trackingCode ?? input.code.slice(0, 80),
          notes: [open.notes, detail].filter(Boolean).join('\n'),
        })
        .where(eq(productReturns.id, open.id));
      return { id: open.id, updated: true };
    }
    const row = await this.create(
      {
        retailerCode: input.retailerCode,
        orderNumber: input.orderNumber,
        requestedAt: today,
        scope: input.scope,
        reason: input.reason,
        status: 'RECIBIDA',
        receivedAt: today,
        productCondition: input.productCondition,
        refundGross: null,
        reverseLogisticsCost: null,
        supplierAction: 'NINGUNA',
        supplierCreditGross: null,
        trackingCode: input.code.slice(0, 80),
        notes: detail,
      },
      userId,
    );
    return { id: row.id, updated: false };
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
    const [row] = await this.db
      .delete(productReturns)
      .where(and(eq(productReturns.id, id)))
      .returning({ id: productReturns.id });
    if (!row) throw new NotFoundException('La devolución no existe');
    return { deleted: true };
  }
}
