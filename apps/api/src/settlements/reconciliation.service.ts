import { CANCELLED_PATTERN } from '@cuadra/shared';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { PENALTY_GROUP_KEY, retailers } from '../database/schema/index.js';
import { PurchasesService, type RowDocument } from '../purchases/purchases.service.js';

export type ReconciliationStatus =
  | 'CONCILIADA'
  | 'CON_DIFERENCIA'
  | 'PENDIENTE'
  | 'SIN_VENTA'
  | 'CANCELADA'
  | 'MULTA';

export interface ReconciliationRow {
  status: ReconciliationStatus;
  /** Motivos de la diferencia (vacío si está conciliada) */
  reasons: string[];
  orderNumber: string | null;
    /**
   * N° de orden para mostrar. Igual a orderNumber, salvo en los retailers que liquidan con
   * otro número (Walmart: se muestra el N° de orden del cliente, solo números, y no la PO "P…")
   */
  orderLabel: string | null;
  itemId: string | null;
  orderDate: string | null;
  productName: string | null;
  sellerSku: string | null;
  /** Precio de la venta (lo que esperamos que pague el retailer por el producto) */
  salePrice: number | null;
  /** Pago del producto informado en la liquidación */
  productPaid: number | null;
  /** Comisión cobrada (negativa) */
  commission: number | null;
  commissionPct: number | null;
  /** Envío, logística y otros cargos (suma, puede ser negativa) */
  otherCharges: number | null;
  /** Cobros de envío y logística (negativos, con IVA): su IVA es crédito fiscal */
  shippingCharges: number | null;
  /** Neto que paga el retailer por esta venta (suma de todos los movimientos) */
  net: number | null;
  paymentStatus: string | null;
  statementNumber: string | null;
  /**
   * "A recibir" de Productos (sin IVA): costo momentáneo × (1 + % utilidad + % devoluciones)
   * de su producto master, por la cantidad vendida. null = el producto no tiene master/costo.
   */
  expectedNet: number | null;
  /** Debíamos recibir = "A recibir" de Productos, sin IVA (se resta directo del Neto) */
  expected: number | null;
  /** Total = Neto − Debíamos recibir: positivo = ganancia, negativo = pérdida */
  result: number | null;
  /**
   * Productos de la venta que no tienen costo (para asignarles un master desde la conciliación).
   * masterId/masterSku vienen si el producto ya tiene master, pero ese master no tiene costo.
   */
  missingProducts: { sellerSku: string | null; name: string | null; masterId: string | null; masterSku: string | null }[];
  /** Documentos de compra (facturas del proveedor) agregados a esta orden */
  documents: RowDocument[];
}

export interface ReconciliationResult {
  retailer: string;
  /** Código del retailer en la base (ej: CENCOSUD, también para la opción fulfillment) */
  retailerCode: string;
  /** % de comisión pactado en la maestra de retailers (null = no se valida) */
  contractCommissionPct: number | null;
  summary: Record<ReconciliationStatus, number>;
  totals: {
    salePrice: number;
    productPaid: number;
    commission: number;
    otherCharges: number;
    net: number;
    /** Solo de las filas que tienen resultado (pagadas y con costo, más cobros sin venta) */
    resultNet: number;
    expected: number;
    result: number;
  };
  /** Ventas pagadas cuyo producto no tiene master/costo (no entran en el resultado) */
  rowsWithoutCost: number;
  /** Pagos de productos sin venta cargada (no entran en el resultado) */
  rowsWithoutSale: number;
  rows: ReconciliationRow[];
}

/** Diferencias menores a $1 se consideran redondeo */
const TOLERANCE = 1;

/**
 * Cómo se cruza cada retailer:
 *  matchBy  ITEM     = por línea (Item id de la venta = Id Artículo de la liquidación)
 *           ORDER    = por orden completa (cuando la venta no trae ID por línea)
 *           ORDER_ID = por orden, usando el número secundario de la venta (ej: Walmart
 *                      liquida con el número del cliente y no con la PO)
 *  expectedPrice  PAID = se espera que paguen lo que pagó el cliente
 *                 UNIT = se espera que paguen el precio unitario/lista
 */
interface MatchConfig {
  /** Retailer en la base de datos (si la opción es una modalidad, ej: CENCOSUD_FULFILLMENT) */
  retailerCode?: string;
  /** Nombre visible de la opción */
  label?: string;
  matchBy: 'ITEM' | 'ORDER' | 'ORDER_ID';
  expectedPrice: 'PAID' | 'UNIT';
  /** Condición SQL extra para elegir qué ventas entran en esta conciliación */
  salesFilter?: string;
  /** Modalidad de liquidación a usar (null = la normal) */
  channel?: 'FULFILLMENT';
}

/** Ventas de despacho propio: columna Fulfillment vacía o "no" */
export const NOT_FULFILLMENT_SQL =
  "coalesce(lower(trim(fulfillment)), '') in ('', 'no', 'n', 'false', '0')";

const DEFAULT_CONFIG: MatchConfig = { matchBy: 'ITEM', expectedPrice: 'PAID' };
const MATCH_CONFIG: Record<string, MatchConfig> = {
  // Cencosud despacho propio: liquida sobre el "Precio" (lista); los descuentos al cliente
  // los asume Cencosud. Las ventas fulfillment tienen otra liquidación y no entran aquí.
  CENCOSUD: { matchBy: 'ORDER', expectedPrice: 'UNIT', salesFilter: NOT_FULFILLMENT_SQL },
  // Cencosud fulfillment: solo ventas fulfillment contra la liquidación de fulfillment
  CENCOSUD_FULFILLMENT: {
    retailerCode: 'CENCOSUD',
    label: 'Cencosud Fulfillment',
    matchBy: 'ORDER',
    expectedPrice: 'UNIT',
    salesFilter: `not (${NOT_FULFILLMENT_SQL})`,
    channel: 'FULFILLMENT',
  },
  // Hites: la liquidación solo trae la orden de compra; se cruza por orden
  HITES: { matchBy: 'ORDER', expectedPrice: 'PAID' },
  // Walmart: la liquidación usa el número de orden del cliente ("Número De Orden" = order_id)
  WALMART: { matchBy: 'ORDER_ID', expectedPrice: 'PAID' },
};

/**
 * true si el retailer liquida con el N° de orden del cliente (Walmart) y no con la PO:
 * ese número es el que se muestra en pantalla.
 */
export const showsCustomerOrderId = (code: string) => MATCH_CONFIG[code.toUpperCase()]?.matchBy === 'ORDER_ID';

/** IVA Chile: para comparar ventas con montos netos (Walmart) contra liquidaciones con IVA */
const VAT_RATE = 1.19;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly purchases: PurchasesService,
  ) {}

  /**
   * Cruza las ventas con los movimientos de liquidación de un retailer,
   * línea por línea (Item id de la venta = Id Artículo de la liquidación).
   */
  async reconcile(code: string): Promise<ReconciliationResult> {
    const optionCode = code.toUpperCase();
    const config = MATCH_CONFIG[optionCode] ?? DEFAULT_CONFIG;

    const [retailer] = await this.db
      .select()
      .from(retailers)
      .where(eq(retailers.code, config.retailerCode ?? optionCode));
    if (!retailer) throw new BadRequestException(`Retailer "${code}" no existe`);

    const contractPct = Number(retailer.commissionPct) > 0 ? Number(retailer.commissionPct) : null;
    // Liquidaciones de la modalidad elegida (null = la normal)
    const channelFilter = config.channel
      ? sql`channel = ${config.channel}`
      : sql.raw('channel is null');

    // Con qué se cruza la venta: su línea (Item id) o su orden completa
    const matchKey = sql.raw(
      { ITEM: 'external_item_id', ORDER: 'order_number', ORDER_ID: 'order_id' }[config.matchBy],
    );
    // Qué precio se espera que pague el retailer, siempre CON IVA
    // (si la venta viene neta, como Walmart, se le suma el IVA)
    const basePrice =
      config.expectedPrice === 'UNIT'
        ? 'coalesce(unit_price, paid_price)'
        : 'coalesce(paid_price, unit_price)';
    const expectedPrice = sql.raw(
      `case when amounts_include_tax then ${basePrice} else round(${basePrice} * ${VAT_RATE}) end`,
    );

    const { rows } = await this.db.execute(sql`
      with
      v as (
        select
          ${matchKey} as match_key,
          min(order_number) as order_number,
          min(order_date) as order_date,
          string_agg(distinct product_name, ' + ') as product_name,
          string_agg(distinct seller_sku, ', ') as seller_sku,
          sum(${expectedPrice} * quantity) as sale_price,
          bool_and(coalesce(status, '') ~* ${CANCELLED_PATTERN}) as cancelled,
          -- Neto que deberíamos recibir (sin IVA), según el costo de su producto master
          sum(t.target_unit * quantity) as expected_net,
          bool_or(t.target_unit is null) as missing_cost,
          -- Productos sin costo (sin catálogo, sin master o master con costo 0)
          jsonb_agg(distinct jsonb_build_object(
            'sellerSku', seller_sku, 'name', product_name,
            'masterId', t.master_id, 'masterSku', t.master_sku
          )) filter (where t.target_unit is null) as missing_products
        from sales_records sr
        -- Producto del catálogo -> master: por SKU seller, o por nombre si la venta no trae SKU
        left join lateral (
          select
            p.id as master_id,
            p.sku_master as master_sku,
            case when p.provisional_cost > 0
              then p.provisional_cost * (1 + p.profit_pct / 100 + p.returns_pct / 100)
            end as target_unit
          from retailer_products rp
          join products p on p.id = rp.product_id
          where rp.retailer_id = sr.retailer_id
            and (
              upper(rp.seller_sku) = upper(sr.seller_sku)
              or (sr.seller_sku is null and lower(trim(rp.name)) = lower(trim(sr.product_name)))
            )
          order by (p.provisional_cost > 0) desc, (rp.status = 'MANUAL') nulls first
          limit 1
        ) t on true
        where retailer_id = ${retailer.id}
          and ${sql.raw(config.salesFilter ?? 'true')}
        group by 1
      ),
      s as (
        select
          sale_item_id,
          max(order_number) as order_number,
          max(product_name) as product_name,
          max(seller_sku) as seller_sku,
          sum(amount_gross) filter (where kind = 'PRODUCT_PAYMENT') as product_paid,
          sum(amount_gross) filter (where kind = 'PRODUCT_PAYMENT' and amount_gross < 0) as returns,
          sum(amount_gross) filter (where kind = 'COMMISSION') as commission,
          max(commission_pct) filter (where kind = 'COMMISSION') as commission_pct,
          sum(amount_gross) filter (where kind not in ('PRODUCT_PAYMENT', 'COMMISSION')) as other_charges,
          sum(amount_gross) filter (where kind in ('SHIPPING', 'LOGISTICS') and amount_gross < 0) as shipping_charges,
          sum(amount_gross) as net,
          count(*) filter (where kind = 'PENALTY') as penalties,
          string_agg(distinct payment_status, ', ') as payment_status,
          string_agg(distinct statement_number, ', ') as statement_number
        from settlement_records
        where retailer_id = ${retailer.id}
          and ${channelFilter}
        group by sale_item_id
      )
      select
        v.match_key is not null as has_sale,
        s.sale_item_id is not null as has_settlement,
        coalesce(v.order_number, s.order_number) as order_number,
        coalesce(v.match_key, s.sale_item_id) as item_id,
        v.order_date::text as order_date,
        coalesce(v.cancelled, false) as cancelled,
        coalesce(v.product_name, s.product_name) as product_name,
        coalesce(v.seller_sku, s.seller_sku) as seller_sku,
        v.sale_price,
        v.expected_net, v.missing_cost, v.missing_products,
        s.product_paid, s.returns, s.commission, s.commission_pct, s.other_charges, s.net, s.penalties,
        s.product_paid, s.returns, s.commission, s.commission_pct, s.other_charges, s.shipping_charges, s.net, s.penalties,
        s.payment_status, s.statement_number
      from v
      full outer join s on s.sale_item_id = v.match_key
      order by v.order_date desc nulls last, 3
    `);

    const result: ReconciliationRow[] = rows.map((r: Record<string, unknown>) => {
      const row: ReconciliationRow = {
        status: 'CONCILIADA',
        reasons: [],
        orderNumber: r.order_number as string | null,
                orderLabel:
          config.matchBy === 'ORDER_ID'
            ? ((r.item_id as string | null) ?? (r.order_number as string | null))
            : (r.order_number as string | null),
        itemId: r.item_id as string | null,
        orderDate: r.order_date as string | null,
        productName: r.product_name as string | null,
        sellerSku: r.seller_sku as string | null,
        salePrice: num(r.sale_price),
        productPaid: num(r.product_paid),
        commission: num(r.commission),
        commissionPct: num(r.commission_pct),
        otherCharges: num(r.other_charges),
        shippingCharges: num(r.shipping_charges),
        net: num(r.net),
        paymentStatus: r.payment_status as string | null,
        statementNumber: r.statement_number as string | null,
        expectedNet: r.missing_cost ? null : num(r.expected_net),
        expected: null,
        result: null,
        missingProducts: (r.missing_products as ReconciliationRow['missingProducts'] | null) ?? [],
        documents: [],
      };
      // Debíamos recibir: el "A recibir" de Productos, sin IVA
      if (row.expectedNet !== null) row.expected = Math.round(row.expectedNet);
      // Cobros sin producto (multas, cargos sin venta, cancelaciones): no se esperaba recibir
      // nada, así que el total es el neto (lo cobrado es pérdida). Si en cambio hay un PAGO
      // de producto sin venta cargada, no sabemos cuánto esperar: queda sin total.
      const noProductExpected = () => {
        if (row.productPaid !== null && row.productPaid !== 0) {
          row.expectedNet = row.expected = null;
          return;
        }
        row.expectedNet = row.expected = 0;
        row.result = Math.round(row.net ?? 0);
      };

      // Todas las multas del retailer, agrupadas en una sola línea
      if (r.item_id === PENALTY_GROUP_KEY) {
        const count = Number(r.penalties ?? 0);
        row.status = 'MULTA';
        row.orderNumber = row.orderLabel = null;
        row.productName = 'Multa sin OC';
        row.reasons.push(`${count} ${count === 1 ? 'cobro' : 'cobros'} por multa`);
        noProductExpected();
        return row;
      }
      if (!r.has_sale) {
        row.status = 'SIN_VENTA';
        noProductExpected();
        if (r.item_id === null) {
          // Movimientos que el retailer informa sin número de orden
          // (ej: "Cargo" de Cencosud, "Merma" de Walmart)
          row.productName = 'Movimientos sin OC';
          row.reasons.push('Movimientos sin número de orden: revisar con el retailer');
          return row;
        }
        row.reasons.push('Aparece en la liquidación pero no hay una venta cargada');
        return row;
      }
      // Orden cancelada: no se espera pago, los montos van en 0
      if (r.cancelled) {
        row.status = 'CANCELADA';
        row.salePrice = 0;
        noProductExpected();
        if (!r.has_settlement) {
          row.productPaid = row.commission = row.otherCharges = row.net = 0;
          row.reasons.push('Orden cancelada');
        } else {
          // Si igual hay movimientos (ej: multa por cancelación), se muestran para revisarlos
          row.reasons.push(
            `Orden cancelada, pero la liquidación informa movimientos por ${clp(row.net ?? 0)}. Revisar`,
          );
        }
        return row;
      }
      if (row.productPaid === null) {
        // Aún no paga: se muestra lo que deberíamos recibir, pero no hay resultado todavía
        row.status = 'PENDIENTE';
        row.reasons.push(
          r.has_settlement
            ? 'Hay cobros, pero aún no se informa el pago del producto'
            : 'No aparece en ninguna liquidación',
        );
        return row;
      }

      // Total: lo que pagó el retailer (Neto) − lo que deberíamos recibir
      if (row.expected !== null && row.net !== null) {
        row.result = Math.round(row.net - row.expected);
      }

      // 0. ¿Hubo devolución? Se informa aparte; el pago de la venta se compara sin ella
      const returns = num(r.returns) ?? 0;
      const salePaid = row.productPaid - returns; // solo los pagos positivos
      if (returns < 0) {
        row.reasons.push(
          salePaid === 0
            ? `Devolución por ${clp(Math.abs(returns))} (el pago original de la venta no está en las liquidaciones cargadas)`
            : `Incluye devolución por ${clp(Math.abs(returns))}`,
        );
      }

      // 1. ¿El pago del producto calza con el precio de venta?
      if (row.salePrice !== null && salePaid !== 0) {
        const diff = salePaid - row.salePrice;
        if (Math.abs(diff) > TOLERANCE) {
          row.reasons.push(
            `Pago del producto ${diff > 0 ? 'mayor' : 'menor'} al precio de venta en ${clp(Math.abs(diff))}`,
          );
        }
      }

      // 2. ¿La comisión cobrada corresponde a su % ?
      if (row.commission !== null && row.commissionPct !== null) {
        const expected = -(row.productPaid * row.commissionPct) / 100;
        const diff = row.commission - expected;
        if (Math.abs(diff) > TOLERANCE) {
          row.reasons.push(
            `Comisión cobrada ${clp(Math.abs(row.commission))} no corresponde al ${row.commissionPct}% (${clp(Math.abs(expected))})`,
          );
        }
      }

      // 3. ¿El % de comisión es el pactado? (solo si está definido en la maestra)
      if (contractPct !== null && row.commissionPct !== null && row.commissionPct !== contractPct) {
        row.reasons.push(`Comisión de ${row.commissionPct}% distinta a la pactada (${contractPct}%)`);
      }

      if (row.reasons.length > 0) row.status = 'CON_DIFERENCIA';
      return row;
    });

        // Documentos de compra de cada orden
    const docs = await this.purchases.documentsByItem(
      retailer.id,
      result.map((r) => r.itemId).filter((k): k is string => k !== null),
    );
    for (const r of result) {
      if (r.itemId !== null) r.documents = docs.get(r.itemId) ?? [];
    }

    const summary: ReconciliationResult['summary'] = {
      CONCILIADA: 0,
      CON_DIFERENCIA: 0,
      PENDIENTE: 0,
      SIN_VENTA: 0,
      CANCELADA: 0,
      MULTA: 0,
    };
    const totals = {
      salePrice: 0,
      productPaid: 0,
      commission: 0,
      otherCharges: 0,
      net: 0,
      resultNet: 0,
      expected: 0,
      result: 0,
    };
    let rowsWithoutCost = 0;
    let rowsWithoutSale = 0;
    for (const r of result) {
      if (r.result !== null) {
        totals.resultNet += r.net ?? 0;
        totals.expected += r.expected ?? 0;
        totals.result += r.result;
      } else if (r.net !== null && r.expected === null && r.status !== 'PENDIENTE') {
        if (r.status === 'SIN_VENTA') rowsWithoutSale++;
        else rowsWithoutCost++;
      }
      summary[r.status]++;
      totals.salePrice += r.salePrice ?? 0;
      totals.productPaid += r.productPaid ?? 0;
      totals.commission += r.commission ?? 0;
      totals.otherCharges += r.otherCharges ?? 0;
      totals.net += r.net ?? 0;
    }

    return {
      retailer: config.label ?? retailer.name,
      retailerCode: retailer.code,
      contractCommissionPct: contractPct,
      summary,
      totals,
      rowsWithoutCost,
      rowsWithoutSale,
      rows: result,
    };
  }
}

function clp(n: number) {
  const abs = `$${Math.abs(Math.round(n)).toLocaleString('es-CL')}`;
  return n < 0 ? `-${abs}` : abs;
}