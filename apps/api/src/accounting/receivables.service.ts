import { expectedPayment, paymentTermsLabel, PAYMENT_RULES, type PaymentRule, type PaymentTerms } from '@cuadra/shared';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { retailers } from '../database/schema/index.js';
import { SalesService } from '../sales/sales.service.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
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
 * Fecha de pago = según cómo paga cada retailer (quincenal, días hábiles desde la entrega,
 * semanal…: ver payment-calendar en @cuadra/shared).
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
        const pay = expectedPayment(termsOf(t), {
          orderDate: s.orderDate,
          deliveredAt: s.deliveredAt,
          dispatchDeadline: s.dispatchDeadline,
          delivered: s.state === 'ENTREGADA',
        });
        const base = s.deliveredAt ?? s.orderDate;
        const dueDate = pay.date;
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
          deliveredAt: s.deliveredAt,
          dueDate,
          /** La fecha depende de una entrega que aún no ocurre (o sin fecha exacta) */
          dueEstimated: pay.estimated,
          dueWhy: pay.why,
          daysOverdue: Math.max(0, overdue),
          daysToDue: Math.max(0, -overdue),
          bucket: bucketOf(overdue),
        };
      })
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));

    const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) as Record<BucketKey, number>;
    const retailersSummary = new Map<
      string,
      {
        code: string;
        name: string;
        orders: number;
        expected: number;
        overdue: number;
        buckets: Record<BucketKey, number>;
        paymentDays: number;
        paymentBase: string;
        paymentRule: PaymentRule;
        terms: string;
        nextPayment: { date: string; amount: number; orders: number } | null;
        commissionPct: number;
      }
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
          paymentRule: termsOf(t).rule,
          terms: paymentTermsLabel(termsOf(t)),
          nextPayment: null,
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

    // Próximos pagos: lo que debería llegar en cada fecha, por retailer
    const byDate = new Map<string, { date: string; retailerCode: string; retailer: string; amount: number; orders: number; estimated: number }>();
    for (const i of items) {
      if (!i.dueDate || i.dueDate < today) continue;
      const k = `${i.dueDate}|${i.retailerCode}`;
      const x = byDate.get(k) ?? { date: i.dueDate, retailerCode: i.retailerCode, retailer: i.retailer, amount: 0, orders: 0, estimated: 0 };
      x.amount += i.expected;
      x.orders++;
      if (i.dueEstimated) x.estimated += i.expected;
      byDate.set(k, x);
    }
    const upcoming = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    for (const r of retailersSummary.values()) {
      const next = upcoming.find((u) => u.retailerCode === r.code);
      r.nextPayment = next ? { date: next.date, amount: next.amount, orders: next.orders } : null;
    }

    return {
      today,
      upcoming,
      buckets: BUCKETS,
      totals,
      retailers: [...retailersSummary.values()].sort((a, b) => b.expected - a.expected),
      items,
      /** Retailers con comisión 0 en la maestra (lo esperado queda igual a la venta) */
      missingCommission: [...retailersSummary.values()].filter((r) => r.commissionPct === 0).map((r) => r.name),
    };
  }
}

type RetailerRow = typeof retailers.$inferSelect;

/** Condiciones de pago de un retailer (sin maestra: 30 días desde la venta) */
function termsOf(t: RetailerRow | undefined): PaymentTerms {
  const rule = (PAYMENT_RULES as readonly string[]).includes(t?.paymentRule ?? '') ? (t!.paymentRule as PaymentRule) : 'DIAS';
  return { rule, days: t?.paymentDays ?? 30, weekday: t?.paymentWeekday ?? 3, base: t?.paymentBase === 'DESPACHO' ? 'DESPACHO' : 'ORDEN' };
}
