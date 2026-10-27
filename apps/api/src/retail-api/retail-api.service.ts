import { CANCELLED_PATTERN } from '@cuadra/shared';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { BASE_DB, DRIZZLE, type Database } from '../database/database.module.js';
import { currentTenantId, runInBackground } from '../database/tenant-context.js';
import { retailApiConnections, retailApiOrderItems, retailApiOrders, retailApiProducts, retailProductChanges } from '../database/schema/index.js';
import { PROVIDERS, providerByCode } from './providers/index.js';
import {
  ProviderError,
  type NormalizedOrder,
  type NormalizedProduct,
  type ProductChanges,
  type ProviderConfig,
  type RetailProvider,
  type UpdateResult,
} from './providers/types.js';
import { decryptSecrets, encryptSecrets, mask } from '../common/secrets.js';
import { orderToSales, retailerIdFor } from './api-to-sales.js';

export interface SyncJob {
  id: string;
  tenantId: string;
  provider: string;
  kind: 'orders' | 'products';
  status: 'RUNNING' | 'DONE' | 'ERROR';
  message: string;
  count: number;
  startedAt: string;
  finishedAt: string | null;
}

const MAX_DAYS = 92;

@Injectable()
export class RetailApiService {
  private readonly logger = new Logger(RetailApiService.name);
  /** Sincronizaciones en curso o recientes (en memoria) */
  private readonly jobs = new Map<string, SyncJob>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(BASE_DB) private readonly base: Database,
  ) {}

  private provider(code: string): RetailProvider {
    const p = providerByCode(code);
    if (!p) throw new NotFoundException(`Retailer "${code}" no tiene conexión por API`);
    return p;
  }

  private async row(code: string) {
    const [r] = await this.db.select().from(retailApiConnections).where(eq(retailApiConnections.provider, code));
    return r ?? null;
  }

  private async config(p: RetailProvider): Promise<ProviderConfig> {
    const r = await this.row(p.code);
    const saved = Object.entries((r?.settings ?? {}) as Record<string, string>).filter(([, v]) => v);
    const settings = { ...Object.fromEntries(p.fields.filter((f) => f.default).map((f) => [f.key, f.default!])), ...Object.fromEntries(saved) };
    return { settings, secrets: decryptSecrets(r?.secrets ?? null) };
  }

  // ------------------------------------------------------------------ Conexiones

  async connections() {
    const rows = await this.db.select().from(retailApiConnections);
    return PROVIDERS.map((p) => {
      const r = rows.find((x) => x.provider === p.code);
      const settings = (r?.settings ?? {}) as Record<string, string>;
      const secrets = decryptSecrets(r?.secrets ?? null);
      return {
        provider: p.code,
        label: p.label,
        howTo: p.howTo,
        docsUrl: p.docsUrl,
        fields: p.fields,
        enabled: r?.enabled ?? false,
        configured: p.fields.filter((f) => f.required).every((f) => (f.secret ? secrets[f.key] : settings[f.key])),
        settings: Object.fromEntries(p.fields.filter((f) => !f.secret).map((f) => [f.key, settings[f.key] ?? f.default ?? ''])),
        // Las claves nunca vuelven completas: solo los últimos 4 caracteres
        secrets: Object.fromEntries(p.fields.filter((f) => f.secret).map((f) => [f.key, mask(secrets[f.key])])),
        status: r?.status ?? 'SIN_PROBAR',
        lastError: r?.lastError ?? null,
        lastTestAt: r?.lastTestAt?.toISOString() ?? null,
        lastOrdersSyncAt: r?.lastOrdersSyncAt?.toISOString() ?? null,
        lastProductsSyncAt: r?.lastProductsSyncAt?.toISOString() ?? null,
        editable: p.editable ?? [],
      };
    });
  }

  /**
   * Desconecta un retailer por API (las ventas se cargarán por archivo).
   * Quita de Ventas las órdenes que llegaron por API, menos las que ya tienen boleta o factura.
   */
  async disconnect(code: string) {
    const p = this.provider(code);
    await this.db
      .update(retailApiConnections)
      .set({ enabled: false, status: 'SIN_PROBAR', lastError: null })
      .where(sql`${retailApiConnections.provider} = ${p.code}`);
    const { rows } = await this.db.execute<{ removed: number; kept: number }>(sql`
      with api as (
        select s.id, s.retailer_id, s.order_number,
          exists (select 1 from customer_receipts cr where cr.retailer_id = s.retailer_id and cr.order_number = s.order_number) as has_doc
        from sales_records s join retailers r on r.id = s.retailer_id
        where r.code = ${p.code} and s.raw->>'__origen' = 'API'
      ), del as (
        delete from sales_records s using api where s.id = api.id and not api.has_doc returning s.id
      )
      select (select count(*) from del)::int as removed,
        (select count(distinct order_number) from api where has_doc)::int as kept
    `);
    return { ok: true, removed: rows[0]?.removed ?? 0, kept: rows[0]?.kept ?? 0 };
  }

  /** Guarda la conexión. Las claves vacías no se tocan (se mantiene la guardada) */
  async save(code: string, input: { enabled: boolean; settings: Record<string, string>; secrets: Record<string, string> }) {
    const p = this.provider(code);
    const current = await this.row(p.code);
    const settings: Record<string, string> = {};
    for (const f of p.fields.filter((x) => !x.secret)) settings[f.key] = (input.settings[f.key] ?? '').trim();
    const secrets = decryptSecrets(current?.secrets ?? null);
    for (const f of p.fields.filter((x) => x.secret)) {
      const v = (input.secrets[f.key] ?? '').trim();
      if (v) secrets[f.key] = v;
    }
    const values = { enabled: input.enabled, settings, secrets: encryptSecrets(secrets), status: 'SIN_PROBAR', lastError: null };
    await this.db
      .insert(retailApiConnections)
      .values({ provider: p.code, ...values })
      .onConflictDoUpdate({ target: [retailApiConnections.tenantId, retailApiConnections.provider], set: values });
    return { ok: true };
  }

  async test(code: string) {
    const p = this.provider(code);
    const cfg = await this.config(p);
    try {
      const r = await p.test(cfg);
      await this.setStatus(p.code, 'OK', null, { lastTestAt: new Date() });
      // Si conecta, se traen altiro las ventas del período (desde el 20 del mes pasado)
      const { from, to } = defaultRange();
      const job = this.startOrders(p.code, from, to);
      return { ok: true, message: r.message, sample: truncate(r.sample), job };
    } catch (err) {
      const message = errMessage(err);
      await this.setStatus(p.code, 'ERROR', message, { lastTestAt: new Date() });
      return { ok: false, message, sample: err instanceof ProviderError && err.body ? err.body : null };
    }
  }

  private async setStatus(code: string, status: string, lastError: string | null, extra: Partial<typeof retailApiConnections.$inferInsert> = {}) {
    await this.db
      .insert(retailApiConnections)
      .values({ provider: code, enabled: true, status, lastError, ...extra })
      .onConflictDoUpdate({ target: [retailApiConnections.tenantId, retailApiConnections.provider], set: { status, lastError, ...extra } });
  }

  // ------------------------------------------------------------------ Sincronizar

  job(id: string) {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== currentTenantId()) throw new NotFoundException('La sincronización ya no existe (¿se reinició la API?)');
    return j;
  }

  /** Corre en segundo plano: el navegador consulta el avance con job(id) */
  startOrders(code: string, from: string, to: string) {
    const p = this.provider(code);
    if (from > to) throw new BadRequestException('La fecha "desde" es posterior a "hasta"');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) throw new BadRequestException(`Máximo ${MAX_DAYS} días por sincronización`);
    return this.run(p, 'orders', async (job) => {
      const cfg = await this.config(p);
      const orders = await p.orders(cfg, from, to, (m) => (job.message = m));
      job.message = `Guardando ${orders.length} órdenes…`;
      const { inSales, fromFile } = await this.saveOrders(p.code, p.label, orders);
      await this.setStatus(p.code, 'OK', null, { lastOrdersSyncAt: new Date() });
      return {
        count: orders.length,
        message:
          `${orders.length} ${orders.length === 1 ? 'orden' : 'órdenes'} de ${p.label} (${from} a ${to}): ` +
          `${inSales} ${inSales === 1 ? 'quedó' : 'quedaron'} en Ventas` +
          (fromFile ? ` · ${fromFile} ya ${fromFile === 1 ? 'estaba cargada' : 'estaban cargadas'} por archivo` : ''),
      };
    });
  }

  startProducts(code: string) {
    const p = this.provider(code);
    return this.run(p, 'products', async (job) => {
      const cfg = await this.config(p);
      const products = await p.products(cfg, (m) => (job.message = m));
      job.message = `Guardando ${products.length} productos…`;
      await this.saveProducts(p.code, products);
      await this.setStatus(p.code, 'OK', null, { lastProductsSyncAt: new Date() });
      return { count: products.length, message: `${products.length} productos de ${p.label} sincronizados` };
    });
  }

  private run(p: RetailProvider, kind: SyncJob['kind'], work: (job: SyncJob) => Promise<{ count: number; message: string }>) {
    const tenantId = currentTenantId()!;
    const running = [...this.jobs.values()].find((j) => j.tenantId === tenantId && j.provider === p.code && j.kind === kind && j.status === 'RUNNING');
    if (running) return running;
    const job: SyncJob = { id: randomUUID(), tenantId, provider: p.code, kind, status: 'RUNNING', message: 'Conectando…', count: 0, startedAt: new Date().toISOString(), finishedAt: null };
    this.jobs.set(job.id, job);
    // Corre fuera del pedido (que termina altiro), con su propia transacción de la empresa
    runInBackground(this.base, tenantId, () => work(job))
      .then((r) => Object.assign(job, { status: 'DONE', count: r.count, message: r.message }))
      .catch(async (err) => {
        const message = errMessage(err);
        this.logger.warn(`${p.code} ${kind}: ${message}`);
        Object.assign(job, { status: 'ERROR', message });
        await runInBackground(this.base, tenantId, () => this.setStatus(p.code, 'ERROR', message)).catch(() => undefined);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        // Se olvidan después de una hora
        setTimeout(() => this.jobs.delete(job.id), 3600000).unref();
      });
    return job;
  }

  /** Guarda las órdenes de la API y las pasa a Ventas */
  private async saveOrders(provider: string, label: string, orders: NormalizedOrder[]) {
    const retailerId = await retailerIdFor(this.db, provider, label);
    let inSales = 0;
    let fromFile = 0;
    for (const o of orders) {
      await this.db.transaction(async (tx) => {
        const values = {
          provider,
          externalId: o.externalId,
          orderNumber: cut(o.orderNumber, 80),
          customerOrderId: cut(o.customerOrderId, 80),
          orderDate: o.orderDate,
          status: cut(o.status, 60),
          customerName: cut(o.customerName, 200),
          customerRut: cut(o.customerRut, 20),
          customerEmail: cut(o.customerEmail, 200),
          address: cut(o.address, 300),
          commune: cut(o.commune, 120),
          region: cut(o.region, 120),
          total: money(o.total),
          shippingTotal: money(o.shippingTotal),
          itemsCount: o.items.length,
          raw: o.raw,
          syncedAt: new Date(),
        };
        // Si esta vez el retailer no entregó el detalle de productos, se conservan los que ya
        // estaban guardados (y el total/envío calculados con ellos)
        const keepItems = o.items.length === 0;
        const update = keepItems
          ? Object.fromEntries(Object.entries(values).filter(([k]) => !['itemsCount', 'total', 'shippingTotal'].includes(k)))
          : values;
        const [row] = await tx
          .insert(retailApiOrders)
          .values(values)
          .onConflictDoUpdate({ target: [retailApiOrders.tenantId, retailApiOrders.provider, retailApiOrders.externalId], set: update })
          .returning({ id: retailApiOrders.id });
        if (!keepItems) await tx.delete(retailApiOrderItems).where(eq(retailApiOrderItems.orderId, row.id));
        if (o.items.length) {
          // Si el retailer repite el id de línea, se le agrega un sufijo para no chocar
          const seen = new Map<string, number>();
          await tx.insert(retailApiOrderItems).values(
            o.items.map((i) => {
              const n = (seen.get(i.externalItemId) ?? 0) + 1;
              seen.set(i.externalItemId, n);
              return {
                orderId: row.id,
                externalItemId: cut(n > 1 ? `${i.externalItemId}#${n}` : i.externalItemId, 80)!,
                sellerSku: cut(i.sellerSku, 120),
                retailerSku: cut(i.retailerSku, 120),
                name: cut(i.name, 300),
                quantity: String(i.quantity || 1),
                unitPrice: money(i.unitPrice),
                paidPrice: money(i.paidPrice),
                shippingAmount: money(i.shippingAmount),
                status: cut(i.status, 60),
                raw: i.raw,
              };
            }),
          );
        }
        // A Ventas (si la orden ya se cargó por archivo, se deja la del archivo)
        if (await orderToSales(tx, provider, retailerId, row.id, o)) inSales++;
        else fromFile++;
      });
    }
    return { inSales, fromFile };
  }

  private async saveProducts(provider: string, products: NormalizedProduct[]) {
    const unique = new Map(products.map((p) => [p.sellerSku, p]));
    for (const p of unique.values()) {
      const values = {
        provider,
        sellerSku: cut(p.sellerSku, 120)!,
        retailerSku: cut(p.retailerSku, 120),
        name: cut(p.name, 300),
        brand: cut(p.brand, 120),
        price: money(p.price),
        salePrice: money(p.salePrice),
        stock: p.stock === null ? null : Math.round(p.stock),
        status: cut(p.status, 60),
        url: cut(p.url, 500),
        imageUrl: cut(p.imageUrl, 500),
        description: p.description ?? null,
        raw: p.raw,
        syncedAt: new Date(),
      };
      await this.db
        .insert(retailApiProducts)
        .values(values)
        .onConflictDoUpdate({ target: [retailApiProducts.tenantId, retailApiProducts.provider, retailApiProducts.sellerSku], set: values });
    }
  }

  // ------------------------------------------------------------------ Consultas

  /** Órdenes traídas por API, con sus productos y si ya están en Ventas (cargadas por archivo) */
  async orders(from: string, to: string, provider?: string) {
    const { rows } = await this.db.execute<{
      id: string;
      provider: string;
      external_id: string;
      order_number: string | null;
      customer_order_id: string | null;
      order_date: string | null;
      status: string | null;
      customer_name: string | null;
      customer_rut: string | null;
      customer_email: string | null;
      address: string | null;
      commune: string | null;
      region: string | null;
      total: number | null;
      shipping_total: number | null;
      synced_at: string;
      items: { sellerSku: string | null; name: string | null; quantity: number; paidPrice: number | null; status: string | null }[] | null;
      in_erp: boolean;
      receipt_id: string | null;
      receipt_number: string | null;
      receipt_status: string | null;
      receipt_type: number | null;
      receipt_total: number | null;
      nc_total: number | null;
      settle_lines: number;
      settle_net: number | null;
      settle_commission: number | null;
      settle_charges: number | null;
      settle_status: string | null;
      settle_statement: string | null;
      supplier_net: number | null;
      supplier_docs: string | null;
    }>(sql`
      select o.id, o.provider, o.external_id, o.order_number, o.customer_order_id,
        to_char(o.order_date at time zone 'America/Santiago', 'YYYY-MM-DD HH24:MI') as order_date,
        o.status, o.customer_name, o.customer_rut, o.customer_email, o.address, o.commune, o.region,
        o.total::float8 as total, o.shipping_total::float8 as shipping_total, o.synced_at::text,
        (select json_agg(json_build_object('sellerSku', i.seller_sku, 'name', i.name, 'quantity', i.quantity::float8,
            'paidPrice', i.paid_price::float8, 'status', i.status) order by i.external_item_id)
          from retail_api_order_items i where i.order_id = o.id) as items,
        exists (
          select 1 from sales_records s join retailers r on r.id = s.retailer_id
          where r.code = o.provider
            and (s.order_number in (o.order_number, o.customer_order_id) or s.order_id in (o.order_number, o.customer_order_id))
        ) as in_erp,
        -- Boleta o factura emitida al cliente (por N° de orden)
        rc.id::text as receipt_id, rc.receipt_number, rc.status as receipt_status, rc.document_type as receipt_type,
        rc.total_gross::float8 as receipt_total, nc.total::float8 as nc_total,
        -- Liquidación del retailer: neto pagado, comisión y cargos (envío/logística)
        coalesce(st.lines, 0)::int as settle_lines, st.net::float8 as settle_net, st.commission::float8 as settle_commission,
        st.charges::float8 as settle_charges, st.payment_status as settle_status, st.statement as settle_statement,
        -- Factura del proveedor asignada a la orden
        sp.net::float8 as supplier_net, sp.docs as supplier_docs
      from retail_api_orders o
      left join retailers rt on rt.code = o.provider
      left join lateral (
        select cr.id, cr.receipt_number, cr.status, cr.document_type, cr.total_gross from customer_receipts cr
        where cr.retailer_id = rt.id and cr.order_number in (o.order_number, o.customer_order_id) limit 1
      ) rc on true
      left join lateral (
        select sum(n.amount_gross) as total from credit_notes n
        where n.retailer_id = rt.id and n.order_number in (o.order_number, o.customer_order_id) and n.status in ('EMITIDA', 'REGISTRADA')
      ) nc on true
      left join lateral (
        select count(*) as lines, sum(x.amount_gross) as net,
          sum(case when x.kind = 'COMMISSION' then x.amount_gross end) as commission,
          sum(case when x.kind in ('COMMISSION', 'SHIPPING', 'LOGISTICS') and x.amount_gross < 0 then -x.amount_gross end) as charges,
          max(x.payment_status) as payment_status, max(x.statement_number) as statement
        from settlement_records x
        where x.retailer_id = rt.id and x.order_number in (o.order_number, o.customer_order_id)
      ) st on true
      left join lateral (
        select sum(pl.amount_net) as net, string_agg(distinct d.document_number, ', ') as docs
        from purchase_document_lines pl join purchase_documents d on d.id = pl.document_id
        where pl.retailer_id = rt.id and pl.order_number in (o.order_number, o.customer_order_id)
      ) sp on true
      where (o.order_date at time zone 'America/Santiago')::date between ${from}::date and ${to}::date
        ${provider ? sql`and o.provider = ${provider.toUpperCase()}` : sql``}
      order by o.order_date desc nulls last
      limit 5000
    `);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      retailer: providerByCode(r.provider)?.label ?? r.provider,
      externalId: r.external_id,
      orderNumber: r.order_number,
      customerOrderId: r.customer_order_id,
      orderDate: r.order_date,
      status: r.status,
      customerName: r.customer_name,
      customerRut: r.customer_rut,
      customerEmail: r.customer_email,
      address: r.address,
      commune: r.commune,
      region: r.region,
      total: r.total,
      shippingTotal: r.shipping_total,
      items: r.items ?? [],
      inErp: r.in_erp,
      syncedAt: r.synced_at,
      ...money(r),
    }));

    /** Boleta, liquidación, factura del proveedor, IVA y resultado de la orden (igual que en Ventas) */
    function money(r: (typeof rows)[number]) {
      const vatOf = (gross: number) => gross - gross / 1.19;
      const cancelled = new RegExp(CANCELLED_PATTERN, 'i').test(r.status ?? '');
      const receipt = r.receipt_id
        ? {
            id: r.receipt_id,
            number: r.receipt_number!,
            status: r.receipt_status!,
            documentType: r.receipt_type ?? 39,
            totalGross: Math.round(r.receipt_total ?? 0),
            creditNotes: Math.round(r.nc_total ?? 0),
          }
        : null;
      const settlement =
        r.settle_lines > 0
          ? {
              net: Math.round(r.settle_net ?? 0),
              commission: Math.round(r.settle_commission ?? 0),
              charges: Math.round(r.settle_charges ?? 0),
              paymentStatus: r.settle_status,
              statement: r.settle_statement,
            }
          : null;
      const supplier =
        r.supplier_net !== null
          ? { net: Math.round(r.supplier_net), gross: Math.round(r.supplier_net * 1.19), documents: r.supplier_docs?.split(', ') ?? [] }
          : null;
      // IVA: el de la boleta (menos notas de crédito) o del total de la orden − IVA compra − IVA de los cargos del retailer
      const saleGross = cancelled ? 0 : receipt ? receipt.totalGross - receipt.creditNotes : (r.total ?? 0);
      const vat = Math.round(vatOf(saleGross) - (supplier ? supplier.gross - supplier.net : 0) - (settlement ? vatOf(settlement.charges) : 0));
      const result = settlement && supplier && !cancelled ? settlement.net - supplier.gross - vat : null;
      return {
        cancelled,
        receipt,
        settlement,
        supplier,
        vat,
        result,
        marginPct: result !== null && r.total ? (result / r.total) * 100 : null,
      };
    }
  }

  /** Respuesta completa del retailer para una orden (para revisar campos) */
  async orderRaw(id: string) {
    const [o] = await this.db.select({ raw: retailApiOrders.raw }).from(retailApiOrders).where(eq(retailApiOrders.id, id));
    if (!o) throw new NotFoundException('La orden no existe');
    return o.raw;
  }

  /** Productos traídos por API y si están en el Catálogo retail del ERP */
  async products(provider?: string) {
    const { rows } = await this.db.execute<{
      id: string;
      provider: string;
      seller_sku: string;
      retailer_sku: string | null;
      name: string | null;
      brand: string | null;
      price: number | null;
      sale_price: number | null;
      stock: number | null;
      status: string | null;
      url: string | null;
      image_url: string | null;
      description: string | null;
      synced_at: string;
      catalog_name: string | null;
      master_sku: string | null;
      sale_from: string | null;
      sale_to: string | null;
      last_change: { status: string; message: string | null; at: string } | null;
    }>(sql`
      select p.id, p.provider, p.seller_sku, p.retailer_sku, p.name, p.brand, p.price::float8 as price,
        p.sale_price::float8 as sale_price, p.stock, p.status, p.url, p.image_url, p.description, p.synced_at::text,
        c.name as catalog_name, m.sku_master as master_sku,
        lc.changes->>'saleFrom' as sale_from, lc.changes->>'saleTo' as sale_to,
        (select json_build_object('status', x.status, 'message', x.message, 'at', x.updated_at)
           from retail_product_changes x where x.provider = p.provider and x.seller_sku = p.seller_sku
           order by x.created_at desc limit 1) as last_change
      from retail_api_products p
      -- Fechas de la última oferta enviada desde Cuadra (los retailers no siempre las devuelven)
      left join lateral (
        select x.changes from retail_product_changes x
        where x.provider = p.provider and x.seller_sku = p.seller_sku and x.status = 'APLICADO' and x.changes ? 'salePrice'
        order by x.created_at desc limit 1
      ) lc on true
      left join lateral (
        select rp.name, rp.product_id from retailer_products rp join retailers r on r.id = rp.retailer_id
        where r.code = p.provider and (rp.seller_sku = p.seller_sku or rp.retailer_sku in (p.seller_sku, p.retailer_sku))
        limit 1
      ) c on true
      left join products m on m.id = c.product_id
      ${provider ? sql`where p.provider = ${provider.toUpperCase()}` : sql``}
      order by p.provider, p.name
      limit 20000
    `);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      retailer: providerByCode(r.provider)?.label ?? r.provider,
      sellerSku: r.seller_sku,
      retailerSku: r.retailer_sku,
      name: r.name,
      brand: r.brand,
      price: r.price,
      salePrice: r.sale_price,
      stock: r.stock,
      status: r.status,
      url: r.url,
      imageUrl: r.image_url,
      description: r.description,
      syncedAt: r.synced_at,
      inCatalog: r.catalog_name !== null,
      masterSku: r.master_sku,
      saleFrom: r.sale_from,
      saleTo: r.sale_to,
      lastChange: r.last_change,
    }));
  }

  // ------------------------------------------------------------------ Modificar productos en el retailer

  /**
   * Envía al retailer los cambios de un producto (stock, precio, oferta, nombre, descripción)
   * y deja el registro en el historial. Si el retailer lo aplica, se actualiza la copia local.
   */
  async updateProduct(code: string, sellerSku: string, changes: ProductChanges, user: string) {
    const p = this.provider(code);
    if (!p.updateProduct) throw new BadRequestException(`${p.label} no permite modificar productos por API`);
    const asked = Object.keys(changes).filter((k) => !['saleFrom', 'saleTo'].includes(k)) as (keyof ProductChanges)[];
    const notAllowed = asked.filter((k) => !(p.editable ?? []).includes(k as never));
    if (notAllowed.length) throw new BadRequestException(`${p.label} no permite cambiar por API: ${notAllowed.join(', ')}`);
    if (!asked.length) throw new BadRequestException('No hay cambios');
    if (changes.salePrice) {
      if (!changes.saleFrom || !changes.saleTo) throw new BadRequestException('La oferta necesita fecha de inicio y de término');
      if (changes.saleTo < changes.saleFrom) throw new BadRequestException('La fecha de término es anterior a la de inicio');
    }
    const [prod] = await this.db
      .select()
      .from(retailApiProducts)
      .where(sql`${retailApiProducts.provider} = ${p.code} and ${retailApiProducts.sellerSku} = ${sellerSku}`);
    if (!prod) throw new NotFoundException('Producto no encontrado: vuelve a traer los productos');
    const price = changes.price ?? num(prod.price);
    const sale = changes.salePrice === undefined ? num(prod.salePrice) : changes.salePrice;
    if (price !== null && sale && sale >= price) throw new BadRequestException('El precio oferta debe ser menor que el precio normal');

    const before = Object.fromEntries(
      asked.map((k) => [k, k === 'price' ? num(prod.price) : k === 'salePrice' ? num(prod.salePrice) : k === 'stock' ? prod.stock : k === 'name' ? prod.name : prod.description]),
    );
    const [rec] = await this.db
      .insert(retailProductChanges)
      .values({ provider: p.code, sellerSku, changes, before, status: 'ENVIANDO', createdBy: user })
      .returning({ id: retailProductChanges.id });

    let result: UpdateResult;
    try {
      const cfg = await this.config(p);
      result = await p.updateProduct(cfg, { sellerSku, retailerSku: prod.retailerSku, price: num(prod.price), salePrice: num(prod.salePrice), raw: prod.raw }, changes);
    } catch (err) {
      result = { status: 'RECHAZADO', message: errMessage(err) };
    }
    await this.finishChange(rec.id, p.code, sellerSku, changes, result);
    return { id: rec.id, ...result };
  }

  /** Guarda cómo terminó un cambio y, si se aplicó, actualiza la copia local del producto */
  private async finishChange(id: string, provider: string, sellerSku: string, changes: ProductChanges, r: UpdateResult) {
    await this.db
      .update(retailProductChanges)
      .set({ status: r.status, message: r.message.slice(0, 2000), reference: cut(r.reference, 120), updatedAt: new Date() })
      .where(eq(retailProductChanges.id, id));
    if (r.status !== 'APLICADO') return;
    const set: Record<string, unknown> = {};
    if (changes.stock !== undefined) set.stock = Math.round(changes.stock);
    if (changes.price !== undefined) set.price = money(changes.price);
    if (changes.salePrice !== undefined) set.salePrice = money(changes.salePrice);
    if (changes.name !== undefined) set.name = cut(changes.name, 300);
    if (changes.description !== undefined) set.description = changes.description;
    if (Object.keys(set).length) {
      await this.db
        .update(retailApiProducts)
        .set(set)
        .where(sql`${retailApiProducts.provider} = ${provider} and ${retailApiProducts.sellerSku} = ${sellerSku}`);
    }
  }

  /** Historial de cambios de un producto. Antes consulta los que siguen en proceso en el retailer */
  async changes(code: string, sellerSku?: string) {
    const p = this.provider(code);
    const pending = await this.db
      .select()
      .from(retailProductChanges)
      .where(
        sql`${retailProductChanges.provider} = ${p.code} and ${retailProductChanges.status} = 'EN_PROCESO' and ${retailProductChanges.reference} is not null
          ${sellerSku ? sql`and ${retailProductChanges.sellerSku} = ${sellerSku}` : sql``}`,
      )
      .limit(10);
    if (pending.length && p.checkUpdate) {
      const cfg = await this.config(p);
      for (const c of pending) {
        const r = await p.checkUpdate(cfg, c.reference!).catch((err) => ({ status: 'EN_PROCESO' as const, message: `No se pudo consultar: ${errMessage(err)}` }));
        // Si lleva más de un día sin respuesta, se da por perdido
        const stale = Date.now() - c.createdAt.getTime() > 86400000;
        if (r.status !== 'EN_PROCESO' || stale) {
          await this.finishChange(c.id, p.code, c.sellerSku, c.changes as ProductChanges, stale && r.status === 'EN_PROCESO' ? { status: 'RECHAZADO', message: 'El retailer no informó el resultado' } : r);
        }
      }
    }
    const rows = await this.db
      .select()
      .from(retailProductChanges)
      .where(sql`${retailProductChanges.provider} = ${p.code} ${sellerSku ? sql`and ${retailProductChanges.sellerSku} = ${sellerSku}` : sql``}`)
      .orderBy(sql`${retailProductChanges.createdAt} desc`)
      .limit(sellerSku ? 30 : 200);
    return rows.map((r) => ({
      id: r.id,
      sellerSku: r.sellerSku,
      changes: r.changes as ProductChanges,
      before: r.before as Partial<ProductChanges> | null,
      status: r.status,
      message: r.message,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

/** Desde el 20 del mes pasado hasta hoy (hora de Chile) */
export function defaultRange() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 2, 20)).toISOString().slice(0, 10), to: today };
}

const cut = (v: string | null | undefined, max: number) => (v === null || v === undefined ? null : String(v).slice(0, max));
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : String(Math.round(v * 100) / 100));
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Muestra recortada de una respuesta (para no mandar megas al navegador) */
function truncate(v: unknown) {
  const s = JSON.stringify(v ?? null, null, 2);
  return s.length > 6000 ? `${s.slice(0, 6000)}\n…` : s;
}
