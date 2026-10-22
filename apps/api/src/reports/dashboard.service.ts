import { Inject, Injectable } from '@nestjs/common';
import { PRICING_CHANNELS, CANCELLED_PATTERN } from '@cuadra/shared';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { ReconciliationService } from '../settlements/reconciliation.service.js';
import { SettlementsService } from '../settlements/settlements.service.js';
import { ReportsService, type TopProduct } from './reports.service.js';

/** Ventas de un período: todo con IVA, sin contar las canceladas */
export interface SalesKpis {
  revenue: number;
  units: number;
  orders: number;
  /** Venta promedio por orden */
  avgTicket: number;
  /** Órdenes canceladas en el período */
  cancelledOrders: number;
}

export interface DashboardRetailerSales {
  code: string;
  label: string;
  revenue: number;
  units: number;
  orders: number;
  /** % de la venta total del período */
  share: number;
}

export interface DashboardConciliation {
  /** Opción de conciliación (ej: CENCOSUD_FULFILLMENT) */
  code: string;
  label: string;
  /** Todo lo que informan las liquidaciones (con IVA) */
  net: number;
  /** Solo de las filas con resultado: Neto, Debíamos recibir y Total (= Neto − Debíamos recibir) */
  resultNet: number;
  expected: number;
  result: number;
  conciliated: number;
  withDifference: number;
  /** Ventas que aún no se pagan y lo que suman (precio de venta con IVA) */
  pendingCount: number;
  pendingAmount: number;
  /** Multas cobradas (negativo) */
  penalties: number;
  rowsWithoutCost: number;
  rowsWithoutSale: number;
}

export interface DashboardDispatch {
  retailerLabel: string;
  orderNumber: string | null;
  productName: string | null;
  status: string | null;
  deadline: string | null;
  /** Días que faltan para el límite de despacho (negativo = atrasado) */
  daysLeft: number | null;
}

export interface Dashboard {
  from: string | null;
  to: string | null;
  /** Período anterior del mismo largo (null si se piden todas las fechas) */
  previous: { from: string; to: string } | null;
  kpis: SalesKpis;
  previousKpis: SalesKpis | null;
  /** Ventas día a día (o mes a mes si el rango es largo) */
  trend: { granularity: 'day' | 'month'; points: { date: string; revenue: number; units: number }[] };
  byRetailer: DashboardRetailerSales[];
  topProducts: TopProduct[];
  /** Conciliación acumulada (todas las ventas y liquidaciones cargadas, sin filtro de fechas) */
  conciliation: { retailers: DashboardConciliation[]; totals: Omit<DashboardConciliation, 'code' | 'label'> };
  dispatch: { pending: number; overdue: number; dueToday: number; next: DashboardDispatch[] };
  alerts: {
    catalogWithoutMaster: number;
    mastersWithoutCost: number;
    salesWithoutCatalog: number;
  };
}

/** Venta bruta con IVA (Walmart informa montos netos) */
const REVENUE_SQL = sql.raw(
  'coalesce(s.paid_price, s.unit_price, 0) * s.quantity * case when s.amounts_include_tax then 1 else 1.19 end',
);
const CANCELLED_SQL = sql.raw(`coalesce(s.status, '') ~* '${CANCELLED_PATTERN}'`);
/** Estados que ya no requieren despacho (enviado, entregado, cancelado, devuelto…) */
const DISPATCHED_SQL = sql.raw(
  "coalesce(s.status, '') ~* 'entreg|enviad|despachad|cancel|anulad|devuel|tr[aá]nsito|shipped|delivered'",
);
/** "Hoy" en Chile, no en la hora del servidor */
const TODAY_SQL = sql.raw("(now() at time zone 'America/Santiago')::date");

/** Si el rango es más largo que esto, la tendencia se muestra por mes */
const MAX_DAILY_POINTS = 62;
const NEXT_DISPATCH_LIMIT = 8;

const LABELS: Record<string, string> = Object.fromEntries(PRICING_CHANNELS.map((c) => [c.code, c.label]));
const ORDER: string[] = PRICING_CHANNELS.map((c) => c.code);
const label = (code: string, name: string) => LABELS[code] ?? name;

const DAY_MS = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly reports: ReportsService,
    private readonly settlements: SettlementsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async dashboard(from?: string, to?: string): Promise<Dashboard> {
    // Si viene "desde" sin "hasta", el período termina hoy
    const end = from && !to ? await this.today() : to;
    const previous = from && end ? previousRange(from, end) : null;

    const [kpis, previousKpis, trend, byRetailer, top, conciliation, dispatch, alerts] = await Promise.all([
      this.salesKpis(from, end),
      previous ? this.salesKpis(previous.from, previous.to) : Promise.resolve(null),
      this.trend(from, end),
      this.byRetailer(from, end),
      this.reports.topProducts(from, end),
      this.conciliation(),
      this.dispatch(),
      this.alerts(),
    ]);

    return {
      from: from ?? null,
      to: end ?? null,
      previous,
      kpis,
      previousKpis,
      trend,
      byRetailer,
      topProducts: top.overall,
      conciliation,
      dispatch,
      alerts,
    };
  }

  private async today(): Promise<string> {
    const { rows } = await this.db.execute<{ today: string }>(sql`select ${TODAY_SQL}::text as today`);
    return rows[0].today;
  }

  private range(from?: string, to?: string) {
    return sql`${from ? sql`and s.order_date >= ${from}` : sql``} ${to ? sql`and s.order_date <= ${to}` : sql``}`;
  }

  private async salesKpis(from?: string, to?: string): Promise<SalesKpis> {
    const { rows } = await this.db.execute<{
      revenue: number;
      units: number;
      orders: number;
      cancelled_orders: number;
    }>(sql`
      select
        coalesce(round(sum(${REVENUE_SQL}) filter (where not ${CANCELLED_SQL})), 0)::float8 as revenue,
        coalesce(sum(s.quantity) filter (where not ${CANCELLED_SQL}), 0)::int as units,
        count(distinct s.retailer_id::text || '|' || s.order_number) filter (where not ${CANCELLED_SQL})::int as orders,
        count(distinct s.retailer_id::text || '|' || s.order_number) filter (where ${CANCELLED_SQL})::int as cancelled_orders
      from sales_records s
      where true ${this.range(from, to)}
    `);
    const r = rows[0];
    return {
      revenue: r.revenue,
      units: r.units,
      orders: r.orders,
      avgTicket: r.orders > 0 ? Math.round(r.revenue / r.orders) : 0,
      cancelledOrders: r.cancelled_orders,
    };
  }

  /** Ventas por día (o por mes), rellenando con 0 los días sin ventas */
  private async trend(from?: string, to?: string): Promise<Dashboard['trend']> {
    // Sin fechas: desde la primera hasta la última venta cargada
    let start = from;
    let end = to;
    if (!start || !end) {
      const { rows } = await this.db.execute<{ min: string | null; max: string | null }>(sql`
        select min(s.order_date)::text as min, max(s.order_date)::text as max
        from sales_records s where true ${this.range(from, to)}
      `);
      start ??= rows[0].min ?? undefined;
      end ??= rows[0].max ?? undefined;
    }
    if (!start || !end) return { granularity: 'day', points: [] };

    const days = (toDate(end).getTime() - toDate(start).getTime()) / DAY_MS + 1;
    const granularity = days > MAX_DAILY_POINTS ? 'month' : 'day';
    const unit = sql.raw(`'${granularity}'`);
    const step = sql.raw(granularity === 'day' ? "'1 day'" : "'1 month'");

    const { rows } = await this.db.execute<{ date: string; revenue: number; units: number }>(sql`
      with serie as (
        select generate_series(
          date_trunc(${unit}, ${start}::date), date_trunc(${unit}, ${end}::date), ${step}::interval
        )::date as d
      ),
      v as (
        select date_trunc(${unit}, s.order_date)::date as d,
          sum(${REVENUE_SQL}) as revenue, sum(s.quantity) as units
        from sales_records s
        where not ${CANCELLED_SQL} and s.order_date between ${start} and ${end}
        group by 1
      )
      select serie.d::text as date,
        coalesce(round(v.revenue), 0)::float8 as revenue,
        coalesce(v.units, 0)::int as units
      from serie left join v on v.d = serie.d
      order by serie.d
    `);
    return { granularity, points: rows };
  }

  private async byRetailer(from?: string, to?: string): Promise<DashboardRetailerSales[]> {
    const { rows } = await this.db.execute<{
      code: string;
      name: string;
      revenue: number;
      units: number;
      orders: number;
    }>(sql`
      select r.code, r.name,
        round(sum(${REVENUE_SQL}))::float8 as revenue,
        sum(s.quantity)::int as units,
        count(distinct s.order_number)::int as orders
      from sales_records s
      join retailers r on r.id = s.retailer_id
      where not ${CANCELLED_SQL} ${this.range(from, to)}
      group by 1, 2
    `);
    const total = rows.reduce((n, r) => n + r.revenue, 0);
    return rows
      .map((r) => ({
        code: r.code,
        label: label(r.code, r.name),
        revenue: r.revenue,
        units: r.units,
        orders: r.orders,
        share: total > 0 ? (r.revenue / total) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /** Resultado de la conciliación de cada retailer (igual que en la página Conciliación) */
  private async conciliation(): Promise<Dashboard['conciliation']> {
    const options = this.settlements.availableRetailers();
    const results = await Promise.all(
      options.map(async (o) => {
        try {
          return { option: o, data: await this.reconciliation.reconcile(o.code) };
        } catch {
          return null; // el retailer aún no existe en la base (nunca se cargó nada)
        }
      }),
    );

    const retailers: DashboardConciliation[] = [];
    for (const item of results) {
      if (!item || item.data.rows.length === 0) continue;
      const { option, data } = item;
      const pending = data.rows.filter((r) => r.status === 'PENDIENTE');
      const fulfillment = option.code !== data.retailerCode;
      retailers.push({
        code: option.code,
        label: `${label(data.retailerCode, data.retailer)}${fulfillment ? ' Fulfillment' : ''}`,
        net: Math.round(data.totals.net),
        resultNet: Math.round(data.totals.resultNet),
        expected: Math.round(data.totals.expected),
        result: Math.round(data.totals.result),
        conciliated: data.summary.CONCILIADA,
        withDifference: data.summary.CON_DIFERENCIA,
        pendingCount: pending.length,
        pendingAmount: Math.round(pending.reduce((n, r) => n + (r.salePrice ?? 0), 0)),
        penalties: Math.round(
          data.rows.filter((r) => r.status === 'MULTA').reduce((n, r) => n + (r.net ?? 0), 0),
        ),
        rowsWithoutCost: data.rowsWithoutCost,
        rowsWithoutSale: data.rowsWithoutSale,
      });
    }
    retailers.sort(
      (a, b) =>
        (ORDER.indexOf(a.code.split('_')[0]) + 1 || 99) - (ORDER.indexOf(b.code.split('_')[0]) + 1 || 99) ||
        a.code.localeCompare(b.code),
    );

    const sum = (key: keyof Omit<DashboardConciliation, 'code' | 'label'>) =>
      retailers.reduce((n, r) => n + r[key], 0);
    return {
      retailers,
      totals: {
        net: sum('net'),
        resultNet: sum('resultNet'),
        expected: sum('expected'),
        result: sum('result'),
        conciliated: sum('conciliated'),
        withDifference: sum('withDifference'),
        pendingCount: sum('pendingCount'),
        pendingAmount: sum('pendingAmount'),
        penalties: sum('penalties'),
        rowsWithoutCost: sum('rowsWithoutCost'),
        rowsWithoutSale: sum('rowsWithoutSale'),
      },
    };
  }

  /** Órdenes que todavía hay que despachar, por fecha límite */
  private async dispatch(): Promise<Dashboard['dispatch']> {
    const pendingOrders = sql`
      select r.code, r.name, s.order_number,
        string_agg(distinct s.product_name, ' + ') as product_name,
        min(s.status) as status,
        min(s.dispatch_deadline) as deadline
      from sales_records s
      join retailers r on r.id = s.retailer_id
      where not ${DISPATCHED_SQL}
      group by 1, 2, 3
    `;
    const [summary, next] = await Promise.all([
      this.db.execute<{ pending: number; overdue: number; due_today: number }>(sql`
        select count(*)::int as pending,
          count(*) filter (where deadline < ${TODAY_SQL})::int as overdue,
          count(*) filter (where deadline = ${TODAY_SQL})::int as due_today
        from (${pendingOrders}) o
      `),
      this.db.execute<{
        code: string;
        name: string;
        order_number: string | null;
        product_name: string | null;
        status: string | null;
        deadline: string | null;
        days_left: number | null;
      }>(sql`
        select o.*, o.deadline::text as deadline, (o.deadline - ${TODAY_SQL})::int as days_left
        from (${pendingOrders}) o
        order by o.deadline nulls last, o.order_number
        limit ${NEXT_DISPATCH_LIMIT}
      `),
    ]);
    const s = summary.rows[0];
    return {
      pending: s.pending,
      overdue: s.overdue,
      dueToday: s.due_today,
      next: next.rows.map((r) => ({
        retailerLabel: label(r.code, r.name),
        orderNumber: r.order_number,
        productName: r.product_name,
        status: r.status,
        deadline: r.deadline,
        daysLeft: r.days_left,
      })),
    };
  }

  /** Cosas que conviene completar para que los reportes y la conciliación cuadren */
  private async alerts(): Promise<Dashboard['alerts']> {
    const { rows } = await this.db.execute<{
      catalog_without_master: number;
      masters_without_cost: number;
      sales_without_catalog: number;
    }>(sql`
      select
        (select count(*) from retailer_products where product_id is null)::int as catalog_without_master,
        (select count(*) from products where provisional_cost <= 0)::int as masters_without_cost,
        -- Productos vendidos (no cancelados) que no están en el catálogo de su retailer
        (select count(distinct s.retailer_id::text || '|' || coalesce(upper(s.seller_sku), lower(trim(s.product_name))))
          from sales_records s
          where not ${CANCELLED_SQL}
            and not exists (
              select 1 from retailer_products rp
              where rp.retailer_id = s.retailer_id
                and (
                  upper(rp.seller_sku) = upper(s.seller_sku)
                  or (s.seller_sku is null and lower(trim(rp.name)) = lower(trim(s.product_name)))
                )
            ))::int as sales_without_catalog
    `);
    const r = rows[0];
    return {
      catalogWithoutMaster: r.catalog_without_master,
      mastersWithoutCost: r.masters_without_cost,
      salesWithoutCatalog: r.sales_without_catalog,
    };
  }
}

/** Período anterior del mismo largo. Ej: 01/10–31/10 -> 31/08–30/09 (31 días) */
function previousRange(from: string, to: string) {
  const start = toDate(from).getTime();
  const days = (toDate(to).getTime() - start) / DAY_MS + 1;
  return {
    from: toIso(new Date(start - days * DAY_MS)),
    to: toIso(new Date(start - DAY_MS)),
  };
}