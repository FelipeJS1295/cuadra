import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CANCELLED_PATTERN, orderStateOfLines, PRICING_CHANNELS, type OrderState } from '@cuadra/shared';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { customerReceipts, retailers } from '../database/schema/index.js';
import {
  NOT_FULFILLMENT_SQL,
  ReconciliationService,
  showsCustomerOrderId,
} from '../settlements/reconciliation.service.js';
import { SettlementsService } from '../settlements/settlements.service.js';

/** IVA Chile */
const VAT_RATE = 1.19;
/** Parte de IVA que trae un monto con IVA: 119 -> 19 */
const vatOf = (gross: number) => gross - gross / VAT_RATE;

const LABELS: Record<string, string> = Object.fromEntries(PRICING_CHANNELS.map((c) => [c.code, c.label]));

/**
 * Una venta (orden) con su resultado:
 *   Total = Liquidación − Proveedor (con IVA) − IVA
 *   IVA   = IVA de la venta (boleta) − IVA de la compra (factura proveedor)
 *           − IVA de la comisión − IVA de los cargos de envío/logística
 */
export interface SaleWithMargin {
  key: string;
  /** Código del retailer en la base (para guardar la boleta) */
  retailerCode: string;
  retailer: string;
  orderNumber: string | null;
  /** N° de orden para mostrar (Walmart: el del cliente, solo números, no la PO "P…") */
  orderLabel: string | null;
  orderDate: string | null;
  dispatchDeadline: string | null;
  productName: string | null;
  status: string | null;
  cancelled: boolean;
  /** API: llegó por la conexión con el retailer · ARCHIVO: se subió el reporte */
  source: 'API' | 'ARCHIVO';
  /** Cliente (razón social si pidió factura) y su RUT */
  customer: string | null;
  customerRut: string | null;
  /** Documento que corresponde: FACTURA si el cliente la pidió, si no BOLETA */
  documentRequested: 'BOLETA' | 'FACTURA';
  /**
   * Costo del producto, sin IVA:
   *  FACTURA  según la factura del proveedor asignada
   *  ESTIMADO según el costo del producto en Productos
   *  null     sin factura ni costo cargado
   */
  cost: number | null;
  costSource: 'FACTURA' | 'ESTIMADO' | null;
  /** Costo con IVA (lo que se le paga al proveedor) */
  costGross: number | null;
  /** Estado global de la orden (ver @cuadra/shared order-status) */
  state: OrderState;
  /** Estado tal como lo informa el retailer (si las líneas difieren, todos separados por " / ") */
  statusRaw: string | null;
  /** Envío que pagó el cliente (con IVA) */
  shippingPrice: number;
  /** Precio de venta + envío (con IVA) */
  saleTotal: number | null;
  /**
   * Liquidación: lo que el retailer se queda de la venta (comisión, envío, logística, otros),
   * con IVA = venta + envío − lo que deposita. Estimada con la comisión del contrato si aún no paga.
   */
  settlementCharges: number | null;
  settlementEstimated: boolean;
  /** IVA a pagar = IVA de la venta − IVA del costo − IVA de la liquidación */
  vatToPay: number | null;
  /** Utilidad = venta − costo − IVA a pagar − liquidación */
  utility: number | null;
  /** true si algún número de la utilidad es estimado (falta liquidación o factura del proveedor) */
  utilityEstimated: boolean;
  /** Lo que pagó el cliente por el producto (con IVA) */
  salePrice: number | null;
  /** Boleta al cliente final (producto + envío, con IVA). null = aún no se ingresa */
  receipt: {
    id: string;
    number: string;
    totalGross: number;
    /** REGISTRADA (a mano) · EMITIENDO · EMITIDA (desde el sistema, con PDF) · REVISAR · BORRADOR (factura en MIPYME) */
    status: string;
    /** 39 boleta · 33 factura */
    documentType: number;
    /** Fecha de emisión en el SII (AAAA-MM-DD); null si se anotó a mano */
    issuedAt: string | null;
    /** Total de notas de crédito emitidas/anotadas sobre la boleta (con IVA) */
    creditNotes: number;
    /** Notas en borrador (falta firmarlas en el Portal MIPYME) */
    draftCreditNotes: number;
  } | null;
  /** Neto que pagó el retailer en la liquidación. null = aún no paga */
  settlementNet: number | null;
  /** Comisión cobrada por el retailer (negativa, con IVA) */
  commission: number | null;
  /** Cargos de envío y logística de la liquidación (negativos, con IVA) */
  shippingCharges: number | null;
  /** Facturas del proveedor: con IVA y sin IVA. null = sin factura */
  supplierGross: number | null;
  supplierNet: number | null;
  /** Detalle del IVA (montos positivos) */
  vatSale: number | null;
  vatPurchase: number;
  vatCommission: number;
  vatShipping: number;
  /** IVA a pagar = venta − compra − comisión − envío */
  vat: number | null;
  /** null hasta tener liquidación y factura del proveedor */
  total: number | null;
  /** Total sobre el precio de venta (%) */
  marginPct: number | null;
}

/** Datos para emitir la boleta o factura de una orden en el SII */
export interface CustomerData {
  orderNumber: string;
  documentType: 'BOLETA' | 'FACTURA';
  customer: { name: string | null; rut: string | null; email: string | null };
  shipping: { name: string | null; address: string | null; commune: string | null; region: string | null };
  /** Solo si el cliente pidió factura */
  billing: { legalName: string | null; rut: string | null; activity: string | null; address: string | null } | null;
  /** Productos de la orden (con IVA y neto) */
  lines: { productName: string | null; quantity: number; amountGross: number; amountNet: number }[];
  /** Con IVA */
  productTotal: number;
  shippingTotal: number;
  /** Producto + envío, con IVA */
  total: number;
  totalNet: number;
  totalVat: number;
}

type SaleGroup = {
  retailer_code: string;
  retailer_name: string;
  fulfillment: boolean;
  order_number: string | null;
  order_id: string | null;
  order_date: string | null;
  dispatch_deadline: string | null;
  product_name: string | null;
  status: string | null;
  cancelled: boolean;
  /** La orden llegó por la API del retailer (no por archivo) */
  from_api: boolean;
  /** Respaldo si la orden no está en ninguna conciliación (con IVA) */
  sale_price: number | null;
  shipping_price: number | null;
  statuses: (string | null)[] | null;
  customer_name: string | null;
  customer_rut: string | null;
  wants_invoice: boolean;
  est_cost: number | null;
  cost_missing: boolean;
  commission_pct: number | null;
  receipt_id: string | null;
  receipt_number: string | null;
  receipt_total: number | null;
  receipt_status: string | null;
  receipt_type: number | null;
  receipt_issued_at: string | null;
  nc_valid: number;
  nc_draft: number;
};

interface Money {
  salePrice: number;
  settlementNet: number;
  paid: boolean;
  commission: number;
  shippingCharges: number;
  supplierNet: number;
  supplierGross: number;
  hasDocuments: boolean;
}

/** Hasta cuántas órdenes se muestran (las más recientes) */
const LIMIT = 500;

@Injectable()
export class SalesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settlements: SettlementsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** Ventas agrupadas por orden, con lo liquidado, lo pagado al proveedor, el IVA y el total */
  async listWithMargin(limit = LIMIT, range?: { from: string; to: string }): Promise<SaleWithMargin[]> {
    // Rango de fechas de la orden (AAAA-MM-DD, ambos incluidos)
    const having = range
      ? sql`having min(s.order_date)::date between ${range.from}::date and ${range.to}::date`
      : sql``;
    const [{ rows: groups }, money] = await Promise.all([
      this.db.execute<SaleGroup>(sql`
        select
          r.code as retailer_code,
          r.name as retailer_name,
          not (${sql.raw(NOT_FULFILLMENT_SQL.replace(/fulfillment/g, 's.fulfillment'))}) as fulfillment,
          s.order_number,
          min(s.order_id) as order_id,
          min(s.order_date)::text as order_date,
          min(s.dispatch_deadline)::text as dispatch_deadline,
          string_agg(distinct s.product_name, ' + ') as product_name,
          string_agg(distinct s.status, ' / ') as status,
          array_agg(s.status) as statuses,
          bool_and(coalesce(s.status, '') ~* ${CANCELLED_PATTERN}) as cancelled,
          round(sum(coalesce(s.shipping_cost, 0)
            * case when s.amounts_include_tax then 1 else ${sql.raw(String(VAT_RATE))} end))::float8 as shipping_price,
          bool_or(coalesce(s.raw->>'__origen', '') = 'API') as from_api,
          coalesce(min(nullif(trim(s.billing_legal_name), '')), min(nullif(trim(s.customer_name), '')), min(nullif(trim(s.shipping_name), ''))) as customer_name,
          coalesce(min(nullif(trim(s.billing_tax_id), '')), min(nullif(trim(s.customer_document), ''))) as customer_rut,
          bool_or(coalesce(s.document_type, '') ilike '%factura%' or coalesce(s.billing_tax_id, '') <> '') as wants_invoice,
          -- Costo estimado: el costo (neto) del producto en Productos
          sum(pc.cost * s.quantity)::float8 as est_cost,
          bool_or(pc.cost is null) as cost_missing,
          max(r.commission_pct)::float8 as commission_pct,
          round(sum(coalesce(s.paid_price, s.unit_price, 0) * s.quantity
            * case when s.amounts_include_tax then 1 else ${sql.raw(String(VAT_RATE))} end))::float8 as sale_price,
          min(cr.id::text) as receipt_id,
          min(cr.receipt_number) as receipt_number,
          min(cr.total_gross)::float8 as receipt_total,
          min(cr.status) as receipt_status,
          min(cr.document_type) as receipt_type,
          min(cr.issued_at)::text as receipt_issued_at,
          -- Notas de crédito: emitidas/anotadas (rebajan la boleta) y borradores sin firmar
          max((select coalesce(sum(n.amount_gross), 0) from credit_notes n
            where n.retailer_id = s.retailer_id and n.order_number = s.order_number
              and n.status in ('EMITIDA', 'REGISTRADA')))::float8 as nc_valid,
          max((select count(*) from credit_notes n
            where n.retailer_id = s.retailer_id and n.order_number = s.order_number
              and n.status = 'BORRADOR'))::int as nc_draft
        from sales_records s
        join retailers r on r.id = s.retailer_id
        left join customer_receipts cr on cr.retailer_id = s.retailer_id and cr.order_number = s.order_number
        -- Producto del catálogo del retailer -> producto con costo (por SKU, o por nombre si no trae SKU)
        left join lateral (
          select nullif(p.provisional_cost, 0) as cost
          from retailer_products rp
          join products p on p.id = rp.product_id
          where rp.retailer_id = s.retailer_id
            and (upper(rp.seller_sku) = upper(s.seller_sku)
              or (s.seller_sku is null and lower(trim(rp.name)) = lower(trim(s.product_name))))
          order by (p.provisional_cost > 0) desc
          limit 1
        ) pc on true
        group by 1, 2, 3, 4
        ${having}
        order by min(s.order_date) desc nulls last, s.order_number desc
        limit ${limit}
      `),
      this.moneyByOrder(),
    ]);

    return groups.map((g) => {
      const state = orderStateOfLines(g.statuses ?? []);
      g.cancelled = state === 'CANCELADA';
      const label = LABELS[g.retailer_code] ?? g.retailer_name;
      const m = money.get(`${g.retailer_code}|${g.order_number}`);
      const salePrice = g.cancelled ? 0 : (m?.salePrice ?? g.sale_price);
      const settlementNet = m?.paid && !(g.cancelled && m.settlementNet === 0) ? m.settlementNet : null;
      const supplierGross = m?.hasDocuments ? m.supplierGross : null;
      const supplierNet = m?.hasDocuments ? m.supplierNet : null;
      const commission = m?.paid ? m.commission : null;
      const shippingCharges = m?.paid ? m.shippingCharges : null;

      // IVA débito: el de la boleta (producto + envío); sin boleta, el del precio de venta + envío.
      // Orden cancelada: no hay venta ni IVA
      // Las notas de crédito rebajan la boleta (y su IVA)
      const vatBase = g.receipt_total !== null ? g.receipt_total - (g.nc_valid ?? 0) : salePrice !== null ? salePrice + (g.shipping_price ?? 0) : null;
      const vatSale = vatBase !== null && !g.cancelled ? vatOf(vatBase) : null;
      const vatPurchase = supplierGross !== null && supplierNet !== null ? supplierGross - supplierNet : 0;
      // La comisión viene negativa (es un cobro): su IVA es crédito a favor
      const vatCommission = commission !== null ? vatOf(-commission) : 0;
      // Cargos de envío/logística facturados por el retailer: también crédito
      const vatShipping = shippingCharges !== null ? vatOf(-shippingCharges) : 0;
      const vat = vatSale !== null ? vatSale - vatPurchase - vatCommission - vatShipping : null;

      const total =
        !g.cancelled && settlementNet !== null && supplierGross !== null && vat !== null
          ? settlementNet - supplierGross - vat
          : null;

      // Costo: el de la factura del proveedor; si no hay, el del producto (Productos guarda el neto)
      const estCost = !g.cost_missing && g.est_cost ? g.est_cost : null;
      const cost = supplierNet !== null ? supplierNet : estCost;
      const costGross = supplierGross !== null ? supplierGross : estCost !== null ? estCost * VAT_RATE : null;
      const costSource = supplierNet !== null ? ('FACTURA' as const) : estCost !== null ? ('ESTIMADO' as const) : null;

      // Venta + envío que pagó el cliente
      const shippingPrice = g.cancelled ? 0 : (g.shipping_price ?? 0);
      const saleTotal = g.cancelled ? 0 : salePrice !== null ? salePrice + shippingPrice : null;

      // Liquidación: lo que se queda el retailer (real si ya pagó; si no, comisión del contrato + envío)
      let settlementCharges: number | null = null;
      let settlementEstimated = false;
      let vatCharges = vatCommission + vatShipping;
      if (g.cancelled) settlementCharges = 0;
      else if (settlementNet !== null && saleTotal !== null) settlementCharges = saleTotal - settlementNet;
      else if (saleTotal !== null && salePrice !== null) {
        const commissionEst = (salePrice * (g.commission_pct ?? 0)) / 100;
        settlementCharges = commissionEst + shippingPrice;
        vatCharges = vatOf(commissionEst);
        settlementEstimated = true;
      }

      // IVA a pagar: venta − costo − liquidación (con el costo estimado si aún no hay factura)
      const vatCost = costGross !== null ? vatOf(costGross) : 0;
      const vatToPay = g.cancelled ? 0 : vatSale !== null ? vatSale - vatCost - vatCharges : null;

      // Utilidad = venta − costo − IVA − liquidación
      const utility =
        g.cancelled
          ? 0
          : saleTotal !== null && costGross !== null && vatToPay !== null && settlementCharges !== null
            ? saleTotal - costGross - vatToPay - settlementCharges
            : null;
      const utilityEstimated = utility !== null && !g.cancelled && (settlementEstimated || costSource !== 'FACTURA');

      return {
        key: `${g.retailer_code}|${g.fulfillment ? 'F' : ''}|${g.order_number}`,
        retailerCode: g.retailer_code,
        retailer: g.fulfillment ? `${label} · Fulfillment` : label,
        orderNumber: g.order_number,
        orderLabel: showsCustomerOrderId(g.retailer_code) ? (g.order_id ?? g.order_number) : g.order_number,
        orderDate: g.order_date,
        dispatchDeadline: g.dispatch_deadline,
        productName: g.product_name,
        status: g.status,
        state,
        statusRaw: g.status,
        cancelled: g.cancelled,
        source: g.from_api ? ('API' as const) : ('ARCHIVO' as const),
        customer: g.customer_name,
        customerRut: g.customer_rut,
        documentRequested: g.wants_invoice ? ('FACTURA' as const) : ('BOLETA' as const),
        cost: round(cost),
        costGross: round(costGross),
        costSource,
        shippingPrice: Math.round(shippingPrice),
        saleTotal: round(saleTotal),
        settlementCharges: round(settlementCharges),
        settlementEstimated,
        vatToPay: round(vatToPay),
        utility: round(utility),
        utilityEstimated,
        salePrice: round(salePrice),
        receipt:
          g.receipt_id && g.receipt_number && g.receipt_total !== null
            ? {
                id: g.receipt_id,
                number: g.receipt_number,
                totalGross: Math.round(g.receipt_total),
                status: g.receipt_status ?? 'REGISTRADA',
                documentType: g.receipt_type ?? 39,
                issuedAt: g.receipt_issued_at,
                creditNotes: Math.round(g.nc_valid ?? 0),
                draftCreditNotes: g.nc_draft ?? 0,
              }
            : null,
        settlementNet: round(settlementNet),
        commission: round(commission),
        shippingCharges: round(shippingCharges),
        supplierGross: round(supplierGross),
        supplierNet: round(supplierNet),
        vatSale: round(vatSale),
        vatPurchase: Math.round(vatPurchase),
        vatCommission: Math.round(vatCommission),
        vatShipping: Math.round(vatShipping),
        vat: round(vat),
        total: round(total),
        marginPct: total !== null && salePrice ? (total / salePrice) * 100 : null,
      };
    });
  }

  /**
   * Datos del cliente de una orden, para emitir la boleta o factura en el SII.
   * Montos con IVA (Walmart informa netos: se les suma el IVA).
   */
  async customerData(retailerCode: string, orderNumber: string, includeCancelled = false): Promise<CustomerData> {
    const { rows } = await this.db.execute<{
      product_name: string | null;
      quantity: number;
      amount: number;
      shipping: number;
      document_type: string | null;
      customer_name: string | null;
      customer_document: string | null;
      customer_email: string | null;
      shipping_name: string | null;
      shipping_address: string | null;
      shipping_commune: string | null;
      shipping_region: string | null;
      billing_legal_name: string | null;
      billing_tax_id: string | null;
      billing_activity: string | null;
      billing_address: string | null;
    }>(sql`
      select
        s.product_name,
        s.quantity,
        (coalesce(s.paid_price, s.unit_price, 0) * s.quantity
          * case when s.amounts_include_tax then 1 else ${sql.raw(String(VAT_RATE))} end)::float8 as amount,
        (coalesce(s.shipping_cost, 0)
          * case when s.amounts_include_tax then 1 else ${sql.raw(String(VAT_RATE))} end)::float8 as shipping,
        s.document_type, s.customer_name, s.customer_document, s.customer_email,
        s.shipping_name, s.shipping_address, s.shipping_commune, s.shipping_region,
        s.billing_legal_name, s.billing_tax_id, s.billing_activity, s.billing_address
      from sales_records s
      join retailers r on r.id = s.retailer_id
      where r.code = ${retailerCode.toUpperCase()} and s.order_number = ${orderNumber}
        and (${includeCancelled} or coalesce(s.status, '') !~* ${CANCELLED_PATTERN})
      order by s.external_item_id
    `);
    if (rows.length === 0) throw new NotFoundException('No se encontró la orden');

    // Datos del cliente: el primer valor no vacío de las líneas de la orden
    const first = <K extends keyof (typeof rows)[number]>(k: K) =>
      rows.map((r) => r[k]).find((v) => v !== null && v !== '') ?? null;

    const billingTaxId = first('billing_tax_id') as string | null;
    const docType = String(first('document_type') ?? '').toUpperCase();
    const productTotal = Math.round(rows.reduce((n, r) => n + r.amount, 0));
    const shippingTotal = Math.round(rows.reduce((n, r) => n + r.shipping, 0));
    const total = productTotal + shippingTotal;

    return {
      orderNumber,
      documentType: docType.includes('FACTURA') || billingTaxId ? 'FACTURA' : 'BOLETA',
      customer: {
        name: first('customer_name') as string | null,
        rut: formatRut(first('customer_document') as string | null),
        email: first('customer_email') as string | null,
      },
      shipping: {
        name: first('shipping_name') as string | null,
        address: first('shipping_address') as string | null,
        commune: first('shipping_commune') as string | null,
        region: first('shipping_region') as string | null,
      },
      billing: billingTaxId
        ? {
            legalName: first('billing_legal_name') as string | null,
            rut: formatRut(billingTaxId),
            activity: first('billing_activity') as string | null,
            address: first('billing_address') as string | null,
          }
        : null,
      lines: rows.map((r) => ({
        productName: r.product_name,
        quantity: r.quantity,
        amountGross: Math.round(r.amount),
        amountNet: Math.round(r.amount / VAT_RATE),
      })),
      productTotal,
      shippingTotal,
      total,
      totalNet: Math.round(total / VAT_RATE),
      totalVat: total - Math.round(total / VAT_RATE),
    };
  }

  /**
   * Boleta al cliente final: una por orden. Si ya existe, se reemplaza.
   */
  async saveReceipt(
    input: { retailerCode: string; orderNumber: string; receiptNumber: string; totalGross: string },
    userId: string | null,
  ) {
    const [retailer] = await this.db
      .select({ id: retailers.id })
      .from(retailers)
      .where(eq(retailers.code, input.retailerCode.toUpperCase()));
    if (!retailer) throw new BadRequestException(`Retailer "${input.retailerCode}" no existe`);

    // Una boleta emitida desde el sistema no se cambia a mano
    const [current] = await this.db
      .select({ status: customerReceipts.status, number: customerReceipts.receiptNumber })
      .from(customerReceipts)
      .where(and(eq(customerReceipts.retailerId, retailer.id), eq(customerReceipts.orderNumber, input.orderNumber)));
    if (current && (current.status === 'EMITIDA' || current.status === 'EMITIENDO')) {
      throw new BadRequestException(`La boleta N° ${current.number} se emitió en el SII desde el sistema: no se puede editar`);
    }

    const [row] = await this.db
      .insert(customerReceipts)
      .values({
        retailerId: retailer.id,
        orderNumber: input.orderNumber,
        receiptNumber: input.receiptNumber,
        totalGross: input.totalGross,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [customerReceipts.retailerId, customerReceipts.orderNumber],
        // Al anotarla a mano (ej: después de revisar en el portal) queda REGISTRADA
        set: { receiptNumber: input.receiptNumber, totalGross: input.totalGross, status: 'REGISTRADA', siiResponse: null },
      })
      .returning({ id: customerReceipts.id });
    return row;
  }

  async deleteReceipt(id: string) {
    const [current] = await this.db
      .select({ status: customerReceipts.status, number: customerReceipts.receiptNumber })
      .from(customerReceipts)
      .where(eq(customerReceipts.id, id));
    if (current?.status === 'EMITIDA' || current?.status === 'EMITIENDO') {
      throw new BadRequestException(
        `La boleta N° ${current.number} está emitida en el SII: para dejarla sin efecto hay que anularla con una nota de crédito`,
      );
    }
    const [row] = await this.db
      .delete(customerReceipts)
      .where(eq(customerReceipts.id, id))
      .returning({ id: customerReceipts.id });
    if (!row) throw new NotFoundException('La boleta ya no existe');
    return { deleted: true };
  }

  /**
   * Montos de cada orden sacados de la conciliación de cada retailer (así cuadran con
   * la página Conciliación). Si el retailer cruza por línea (Falabella), se suman las
   * líneas de la misma orden.
   */
  private async moneyByOrder(): Promise<Map<string, Money>> {
    const map = new Map<string, Money>();
    const options = this.settlements.availableRetailers();
    const results = await Promise.all(
      options.map((o) => this.reconciliation.reconcile(o.code).catch(() => null)),
    );
    for (const data of results) {
      if (!data) continue;
      for (const r of data.rows) {
        // Solo filas con venta (no multas ni pagos sin venta)
        if (r.status === 'SIN_VENTA' || r.status === 'MULTA' || !r.orderNumber) continue;
        const key = `${data.retailerCode}|${r.orderNumber}`;
        const m = map.get(key) ?? {
          salePrice: 0,
          settlementNet: 0,
          paid: false,
          commission: 0,
          shippingCharges: 0,
          supplierNet: 0,
          supplierGross: 0,
          hasDocuments: false,
        };
        m.salePrice += r.salePrice ?? 0;
        if (r.productPaid !== null) {
          m.paid = true;
          m.settlementNet += r.net ?? 0;
          m.commission += r.commission ?? 0;
          m.shippingCharges += r.shippingCharges ?? 0;
        }
        for (const d of r.documents) {
          m.hasDocuments = true;
          m.supplierNet += d.amountNet;
          m.supplierGross += d.amountGross;
        }
        map.set(key, m);
      }
    }
    return map;
  }
}

/** "17396420K" -> "17.396.420-K" (si no parece RUT, se deja como viene) */
function formatRut(value: string | null): string | null {
  if (!value) return null;
  const clean = value.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2 || !/^\d+[0-9K]$/.test(clean)) return value.trim();
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

const round = (n: number | null) => (n === null ? null : Math.round(n));