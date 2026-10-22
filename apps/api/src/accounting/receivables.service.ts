import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { retailers } from '../database/schema/index.js';
import { SalesService } from '../sales/sales.service.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Tramos de antigüedad (días vencidos) */
export const BUCKETS = [
  { key: 'POR_VENCER', label: 'Por vencer' },
  { key: 'D1_30', label: '1–30 días' },
  { key: 'D31_60', label: '31–60 días' },
  { key: 'D61_90', label: '61–90 días' },
  { key: 'D90', label: '+90 días' },
] as const;
type BucketKey = (typeof BUCKETS)[number]['key'];

const bucketOf = (overdue: number): BucketKey =>
  overdue <= 0 ? 'POR_VENCER' : overdue <= 30 ? 'D1_30' : overdue <= 60 ? 'D31_60' : overdue <= 90 ? 'D61_90' : 'D90';

/**
 * Cuentas por cobrar: órdenes vendidas (no canceladas) que el retailer todavía no paga
 * en una liquidación. Lo esperado = venta − comisión pactada (maestra de retailers).
 * Vencimiento = fecha base (orden o despacho, según el retailer) + días de pago.
 */
@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly sales: SalesService,
  ) {}

  async get() {
    const today = todayCL();
    const [list, terms] = await Promise.all([this.sales.listWithMargin(100000), this.db.select().from(retailers)]);
    const byCode = new Map(terms.map((t) => [t.code, t]));

    const items = list
      .filter((s) => !s.cancelled && s.orderNumber && s.settlementNet === null && (s.salePrice ?? 0) > 0)
      .map((s) => {
        const t = byCode.get(s.retailerCode);
        const commissionPct = Number(t?.commissionPct ?? 0);
        const base = t?.paymentBase === 'DESPACHO' ? (s.dispatchDeadline ?? s.orderDate) : s.orderDate;
        const dueDate = base ? addDays(base, t?.paymentDays ?? 30) : null;
        const overdue = dueDate ? diffDays(dueDate, today) : 0;
        const expected = Math.round((s.salePrice ?? 0) * (1 - commissionPct / 100));
        return {
          retailerCode: s.retailerCode,
          retailer: s.retailer,
          orderNumber: s.orderNumber!,
          orderLabel: s.orderLabel,
          orderDate: s.orderDate,
          productName: s.productName,
          status: s.status,
          salePrice: s.salePrice ?? 0,
          commissionPct,
          expected,
          baseDate: base,
          dueDate,
          daysOverdue: Math.max(0, overdue),
          daysToDue: Math.max(0, -overdue),
          bucket: bucketOf(overdue),
        };
      })
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));

    const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) as Record<BucketKey, number>;
    const retailersSummary = new Map<
      string,
      { code: string; name: string; orders: number; expected: number; overdue: number; buckets: Record<BucketKey, number>; paymentDays: number; paymentBase: string; commissionPct: number }
    >();
    const totals = { orders: 0, expected: 0, overdue: 0, buckets: emptyBuckets() };
    for (const i of items) {
      const t = byCode.get(i.retailerCode);
      const r =
        retailersSummary.get(i.retailerCode) ??
        {
          code: i.retailerCode,
          name: i.retailer,
          orders: 0,
          expected: 0,
          overdue: 0,
          buckets: emptyBuckets(),
          paymentDays: t?.paymentDays ?? 30,
          paymentBase: t?.paymentBase ?? 'ORDEN',
          commissionPct: Number(t?.commissionPct ?? 0),
        };
      r.orders++;
      r.expected += i.expected;
      r.buckets[i.bucket] += i.expected;
      if (i.daysOverdue > 0) r.overdue += i.expected;
      retailersSummary.set(i.retailerCode, r);
      totals.orders++;
      totals.expected += i.expected;
      totals.buckets[i.bucket] += i.expected;
      if (i.daysOverdue > 0) totals.overdue += i.expected;
    }

    return {
      today,
      buckets: BUCKETS,
      totals,
      retailers: [...retailersSummary.values()].sort((a, b) => b.expected - a.expected),
      items,
      /** Retailers con comisión 0 en la maestra (lo esperado queda igual a la venta) */
      missingCommission: [...retailersSummary.values()].filter((r) => r.commissionPct === 0).map((r) => r.name),
    };
  }
}
