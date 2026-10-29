import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ReceivablesService } from '../accounting/receivables.service.js';
import { VatService } from '../accounting/vat.service.js';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { SalesService } from '../sales/sales.service.js';
import { SiiProviderService } from '../sii/sii-provider.service.js';
import { SettingsService } from './settings.service.js';

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());

export interface Task {
  id: string;
  /** Frase simple: "8 ventas no tienen boleta" */
  title: string;
  /** Qué ganas o qué pasa si no lo haces */
  why: string;
  action: string;
  href: string;
  count: number;
  tone: 'rojo' | 'amarillo' | 'azul';
}

/**
 * Inicio en lenguaje simple: cuánto vendiste, cuánto te pagaron, cuánto te deben,
 * cuánto ganaste y qué tienes que hacer hoy.
 */
@Injectable()
export class HomeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly sales: SalesService,
    private readonly receivables: ReceivablesService,
    private readonly vat: VatService,
    private readonly settings: SettingsService,
    private readonly sii: SiiProviderService,
  ) {}

  async summary(month?: string) {
    const today = todayCL();
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
    const [y, mm] = m.split('-').map(Number);
    const from = `${m}-01`;
    const last = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
    const to = last < today ? last : today;

    const [rows, cxc, vatMonths, siiCfg, counts] = await Promise.all([
      this.sales.listWithMargin(20000, { from, to }),
      this.receivables.get(),
      this.vat.months(3),
      this.sii.status(),
      this.db.execute<{ products: number; without_cost: number; sales: number; settlements: number; connections: number }>(sql`
        select
          (select count(*) from products)::int as products,
          (select count(*) from products p where p.provisional_cost <= 0)::int as without_cost,
          (select count(*) from sales_records)::int as sales,
          (select count(*) from settlement_records)::int as settlements,
          (select count(*) from retail_api_connections where status = 'OK')::int as connections
      `),
    ]);
    const c = counts.rows[0];
    const valid = rows.filter((r) => !r.cancelled);
    const sum = (f: (r: (typeof rows)[number]) => number | null) => Math.round(valid.reduce((n, r) => n + (f(r) ?? 0), 0));
    const done = valid.filter((r) => r.total !== null);
    const vatMonth = vatMonths.find((v) => v.month === m) ?? null;
    // Lo que te deben de las ventas de este mes (las de otros meses no entran en el resumen)
    const monthOwed = cxc.items.filter((i) => {
      const d = String(i.orderDate ?? '').slice(0, 10);
      return d >= from && d <= last;
    });
    const owed = monthOwed.reduce((n, i) => n + i.expected, 0);
    const owedOverdue = monthOwed.filter((i) => i.daysOverdue > 0).reduce((n, i) => n + i.expected, 0);

    const tasks: Task[] = [];
    const noReceipt = valid.filter((r) => !r.receipt && r.orderNumber);
    if (noReceipt.length)
      tasks.push({
        id: 'boletas',
        title: `${noReceipt.length} ${noReceipt.length === 1 ? 'venta no tiene' : 'ventas no tienen'} boleta`,
        why: 'Toda venta debe tener su boleta: el SII la exige y sin ella el IVA no cuadra.',
        action: siiCfg.can.boletas ? 'Emitir boletas' : siiCfg.enabled ? 'Anotar boletas' : 'Conectar el SII',
        href: siiCfg.enabled ? '/ventas?filtro=sin-boleta' : '/configuracion?tab=sii',
        count: noReceipt.length,
        tone: 'rojo',
      });
    const cancelledWithReceipt = rows.filter(
      (r) => r.cancelled && r.receipt && ['EMITIDA', 'REGISTRADA'].includes(r.receipt.status) && r.receipt.creditNotes < r.receipt.totalGross,
    );
    if (cancelledWithReceipt.length)
      tasks.push({
        id: 'notas-credito',
        title: `${cancelledWithReceipt.length} ${cancelledWithReceipt.length === 1 ? 'venta cancelada tiene' : 'ventas canceladas tienen'} boleta sin anular`,
        why: 'Si no haces la nota de crédito, pagas IVA por una venta que no ocurrió.',
        action: 'Hacer notas de crédito',
        href: '/impuestos?tab=notas',
        count: cancelledWithReceipt.length,
        tone: 'rojo',
      });
    if (cxc.totals.overdue > 0)
      tasks.push({
        id: 'cobrar',
        title: `Los retailers te deben ${clp(cxc.totals.overdue)} atrasado (todos los meses)`,
        why: 'Son ventas que ya debieron pagarte según los días de pago de cada retailer, de cualquier mes.',
        action: 'Ver quién te debe',
        href: '/cobros',
        count: cxc.items.filter((i) => i.daysOverdue > 0).length,
        tone: 'amarillo',
      });
    const fab = (await this.settings.businessMode()) === 'FABRICANTE';
    // Fabricante: no hay factura de proveedor por venta (el costo sale de los insumos)
    const noSupplier = fab ? [] : valid.filter((r) => r.supplierGross === null);
    if (noSupplier.length && c.settlements > 0)
      tasks.push({
        id: 'proveedor',
        title: `${noSupplier.length} ${noSupplier.length === 1 ? 'venta no tiene' : 'ventas no tienen'} factura de proveedor`,
        why: 'Sin el costo no podemos decirte cuánto ganaste en esas ventas.',
        action: 'Asignar facturas',
        href: '/compras',
        count: noSupplier.length,
        tone: 'azul',
      });
    if (c.without_cost > 0)
      tasks.push({
        id: 'costos',
        title: `${c.without_cost} ${c.without_cost === 1 ? 'producto no tiene' : 'productos no tienen'} costo`,
        why: fab
          ? 'Arma su receta de insumos (o pon un costo) para saber cuánto ganas en cada venta.'
          : 'Con el costo calculamos tu ganancia esperada antes de que llegue la factura.',
        action: fab ? 'Armar recetas' : 'Poner costos',
        href: '/productos',
        count: c.without_cost,
        tone: 'azul',
      });

    return {
      month: m,
      from,
      to,
      company: (await this.settings.company()).name,
      // Peras y manzanas
      sold: sum((r) => r.salePrice),
      orders: valid.length,
      cancelled: rows.length - valid.length,
      paid: sum((r) => r.settlementNet),
      owed: Math.round(owed),
      owedOverdue: Math.round(owedOverdue),
      // Costo de lo vendido: facturas de proveedor (revendedor) o insumos (fabricante)
      supplierCost: fab ? sum((r) => r.costGross) : sum((r) => r.supplierGross),
      vatToPay: vatMonth ? Math.round(vatMonth.balance) : null,
      profit: Math.round(done.reduce((n, r) => n + (r.total ?? 0), 0)),
      profitOrders: done.length,
      profitPct: (() => {
        const base = done.reduce((n, r) => n + (r.salePrice ?? 0), 0);
        return base ? (done.reduce((n, r) => n + (r.total ?? 0), 0) / base) * 100 : null;
      })(),
      byRetailer: Object.values(
        valid.reduce<Record<string, { retailer: string; sold: number; orders: number; paid: number }>>((acc, r) => {
          const k = r.retailerCode;
          acc[k] ??= { retailer: r.retailer.replace(' · Fulfillment', ''), sold: 0, orders: 0, paid: 0 };
          acc[k].sold += r.salePrice ?? 0;
          acc[k].orders++;
          acc[k].paid += r.settlementNet ?? 0;
          return acc;
        }, {}),
      ).sort((a, b) => b.sold - a.sold),
      tasks,
      setup: {
        siiConfigured: siiCfg.enabled,
        hasProducts: c.products > 0,
        hasSales: c.sales > 0,
        hasSettlements: c.settlements > 0,
        retailersConnected: c.connections,
      },
    };
  }

  /** Pasos del asistente de inicio, con su estado */
  async onboarding() {
    const company = await this.settings.company();
    const sii = await this.settings.siiPublic();
    const { rows } = await this.db.execute<{ sales: number; costs: number; connections: number; settlements: number }>(sql`
      select (select count(*) from sales_records)::int as sales,
        (select count(*) from products where provisional_cost > 0)::int as costs,
        (select count(*) from retail_api_connections where status = 'OK')::int as connections,
        (select count(*) from settlement_records)::int as settlements
    `);
    const c = rows[0];
    const marks = company.onboarding ?? {};
    const step = (id: string, done: boolean) => ({ id, status: done ? 'HECHO' : (marks[id] ?? 'PENDIENTE') });
    const steps = [
      step('empresa', Boolean(company.taxId && company.legalName)),
      step('ventas', c.sales > 0 || c.connections > 0),
      step('liquidaciones', c.settlements > 0),
      step('costos', c.costs > 0),
      step('sii', sii.configured),
    ];
    return { steps, completed: steps.filter((s) => s.status !== 'PENDIENTE').length, total: steps.length };
  }
}

const clp = (n: number) => `$${Math.round(n).toLocaleString('es-CL')}`;
