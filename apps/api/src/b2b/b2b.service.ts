import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CANCELLED_PATTERN, PRICING_CHANNELS } from '@cuadra/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BASE_DB, DRIZZLE, type Database } from '../database/database.module.js';
import { currentTenantId, runInBackground } from '../database/tenant-context.js';
import { notifications, retailerProducts, retailers, retailSkuNames, salesRecords, suppliers, tenants } from '../database/schema/index.js';
import { retailerIdFor } from '../retail-api/api-to-sales.js';
import { courierOf } from '../sales/sales.service.js';
import { showsCustomerOrderId } from '../settlements/reconciliation.service.js';

const LABELS: Record<string, string> = Object.fromEntries(PRICING_CHANNELS.map((c) => [c.code, c.label]));

/** "76.543.210-3" -> "76543210-3" (para comparar RUT) */
const normRut = (r: string | null | undefined) => (r ?? '').replace(/[.\s]/g, '').toUpperCase();
/** Código del canal del cliente en la cuenta del proveedor: "CLI-765432103" */
const channelCode = (rut: string) => `CLI-${normRut(rut).replace(/[^0-9K]/g, '')}`.slice(0, 20);

/** Lo que viaja al proveedor por cada producto vendido (sin montos ni datos del cliente final) */
interface SentLine {
  lineId: string;
  /** Retailer donde se vendió (Paris, Falabella…) */
  retailer: string;
  /** Orden de compra como se ve en Ventas */
  orderNumber: string;
  orderDate: string | null;
  dispatchDeadline: string | null;
  courier: string | null;
  sku: string;
  name: string;
  quantity: number;
  status: string | null;
}

/**
 * Ventas entre empresas de Cuadra: una empresa de compra y venta (ej. Jamaroff) envía ventas a su
 * proveedor (ej. Jerk Home). En la cuenta del proveedor llegan como ventas de un canal con el nombre
 * del cliente, con sus productos para configurar (SKU padre/color, nombre, precio), y un aviso.
 */
@Injectable()
export class B2bService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(BASE_DB) private readonly base: Database,
  ) {}

  /** Empresas de Cuadra por RUT (fuera de la empresa actual) */
  private async platformByRut() {
    const rows = await this.base.select({ id: tenants.id, name: tenants.name, legalName: tenants.legalName, taxId: tenants.taxId, status: tenants.status }).from(tenants);
    const map = new Map<string, (typeof rows)[number]>();
    for (const t of rows) if (t.taxId && t.status === 'ACTIVA' && t.id !== currentTenantId()) map.set(normRut(t.taxId), t);
    return map;
  }

  /** Mis proveedores, y cuáles tienen cuenta en Cuadra (solo a esos se les puede enviar) */
  async suppliers() {
    const [list, platform] = await Promise.all([this.db.select().from(suppliers).orderBy(suppliers.name), this.platformByRut()]);
    return list
      .map((s) => {
        const t = s.taxId ? platform.get(normRut(s.taxId)) : undefined;
        return { id: s.id, name: s.name, taxId: s.taxId, onPlatform: Boolean(t), platformName: t?.name ?? null };
      })
      .sort((a, b) => Number(b.onPlatform) - Number(a.onPlatform) || a.name.localeCompare(b.name));
  }

  /**
   * Envía las ventas elegidas al proveedor. Viajan: retailer, orden de compra, fecha de despacho,
   * courier, SKU (el SKU padre/color si se asignó), nombre, cantidad y estado. No van montos ni
   * datos del cliente final. Reenviar actualiza lo enviado (no duplica).
   */
  async send(supplierId: string, orders: { retailerCode: string; orderNumber: string }[], user: string) {
    const [sup] = await this.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) throw new NotFoundException('El proveedor no existe');
    const target = sup.taxId ? (await this.platformByRut()).get(normRut(sup.taxId)) : undefined;
    if (!target) throw new BadRequestException(`${sup.name} no tiene cuenta en Cuadra: no se le pueden enviar ventas`);
    const [me] = await this.base.select().from(tenants).where(eq(tenants.id, currentTenantId()!));
    if (!me.taxId) throw new BadRequestException('Falta el RUT de tu empresa (Configuración → Empresa): el proveedor lo necesita para identificarte');

    // Líneas de las órdenes elegidas (sin las canceladas)
    const lines: SentLine[] = [];
    const ids: string[] = [];
    for (const o of orders) {
      const { rows } = await this.db.execute<{
        id: string;
        code: string;
        name: string;
        order_number: string;
        order_id: string | null;
        order_date: string | null;
        deadline: string | null;
        carrier: string | null;
        sku: string | null;
        product: string | null;
        quantity: number;
        status: string | null;
        parent_sku: string | null;
        own_name: string | null;
      }>(sql`
        select s.id, r.code, r.name, s.order_number, s.order_id, s.order_date::text, s.dispatch_deadline::text as deadline, s.carrier,
          s.seller_sku as sku, s.product_name as product, s.quantity, s.status, sn.parent_sku, sn.name as own_name
        from sales_records s
        join retailers r on r.id = s.retailer_id
        left join retail_sku_names sn on sn.provider = r.code and sn.seller_sku = upper(s.seller_sku)
        where r.code = ${o.retailerCode.toUpperCase()} and s.order_number = ${o.orderNumber}
          and coalesce(s.status, '') !~* ${CANCELLED_PATTERN}
      `);
      for (const r of rows) {
        const sku = (r.parent_sku ?? r.sku ?? '').trim();
        if (!sku) throw new BadRequestException(`La orden ${r.order_number} tiene un producto sin SKU: asígnale un SKU padre/color antes de enviarla`);
        ids.push(r.id);
        lines.push({
          lineId: r.id,
          retailer: LABELS[r.code] ?? r.name,
          orderNumber: showsCustomerOrderId(r.code) ? (r.order_id ?? r.order_number) : r.order_number,
          orderDate: r.order_date?.slice(0, 10) ?? null,
          dispatchDeadline: r.deadline,
          courier: courierOf(r.code, r.carrier),
          sku: sku.toUpperCase().slice(0, 80),
          name: (r.own_name ?? r.product ?? sku).trim().slice(0, 300),
          quantity: Math.max(1, Number(r.quantity) || 1),
          status: r.status,
        });
      }
    }
    if (!lines.length) throw new BadRequestException('Las órdenes elegidas no tienen productos para enviar (¿están canceladas?)');

    const sender = { id: me.id, name: me.name, legalName: me.legalName ?? me.name, taxId: me.taxId };
    // En la cuenta del proveedor (su propia transacción y aislamiento)
    const received = await runInBackground(this.base, target.id, () => this.receive(sender, lines, user));

    const now = new Date();
    await this.db.update(salesRecords).set({ sentToSupplier: target.name, sentToSupplierAt: now }).where(inArray(salesRecords.id, ids));
    return { supplier: target.name, orders: new Set(lines.map((l) => `${l.retailer}|${l.orderNumber}`)).size, lines: lines.length, ...received };
  }

  /** Corre en la empresa del proveedor: crea el canal del cliente, sus productos, las ventas y el aviso */
  private async receive(sender: { id: string; name: string; legalName: string; taxId: string }, lines: SentLine[], user: string) {
    const code = channelCode(sender.taxId);
    const retailerId = await retailerIdFor(this.db, code, sender.name);

    // Productos del cliente (nuevos sin precio; los existentes se mantienen)
    const skus = [...new Map(lines.map((l) => [l.sku, l.name])).entries()];
    const inserted = await this.db
      .insert(retailerProducts)
      .values(skus.map(([sku, name]) => ({ retailerId, retailerSku: sku, sellerSku: sku, name, raw: { __origen: 'CUADRA', from: sender.id } })))
      .onConflictDoNothing({ target: [retailerProducts.retailerId, retailerProducts.retailerSku] })
      .returning({ id: retailerProducts.id });
    const prices = new Map(
      (
        await this.db
          .select({ sku: retailerProducts.retailerSku, price: retailerProducts.listPrice })
          .from(retailerProducts)
          .where(and(eq(retailerProducts.retailerId, retailerId), inArray(retailerProducts.retailerSku, skus.map(([s]) => s))))
      ).map((p) => [p.sku, p.price]),
    );

    // Ventas: una línea por producto, identificada por la línea del cliente (reenviar actualiza)
    const existing = new Set(
      (
        await this.db
          .select({ key: salesRecords.externalItemId })
          .from(salesRecords)
          .where(and(eq(salesRecords.retailerId, retailerId), inArray(salesRecords.externalItemId, lines.map((l) => `CQ|${l.lineId}`))))
      ).map((r) => r.key),
    );
    for (const l of lines) {
      const price = prices.get(l.sku) ?? null;
      const values = {
        retailerId,
        externalItemId: `CQ|${l.lineId}`,
        orderNumber: l.orderNumber.slice(0, 50),
        orderId: l.orderNumber.slice(0, 50),
        orderDate: l.orderDate,
        status: (l.status ?? 'Pendiente').slice(0, 50),
        sellerSku: l.sku.slice(0, 60),
        productName: l.name,
        quantity: l.quantity,
        unitPrice: price,
        paidPrice: price,
        dispatchDeadline: l.dispatchDeadline,
        carrier: l.courier?.slice(0, 100) ?? null,
        // El cliente de esta venta es la empresa que la envió (a ella se le factura)
        documentType: 'FACTURA',
        customerName: sender.legalName.slice(0, 200),
        customerDocument: sender.taxId.slice(0, 20),
        billingLegalName: sender.legalName.slice(0, 200),
        billingTaxId: sender.taxId.slice(0, 20),
        // El proveedor pone precios netos: Ventas les suma el IVA
        amountsIncludeTax: false,
        raw: { __origen: 'CUADRA', from: sender.id, fromName: sender.name, retailer: l.retailer, sentBy: user, sentAt: new Date().toISOString() },
      };
      await this.db
        .insert(salesRecords)
        .values(values)
        .onConflictDoUpdate({
          target: [salesRecords.retailerId, salesRecords.externalItemId],
          set: {
            status: values.status,
            sellerSku: values.sellerSku,
            productName: values.productName,
            quantity: values.quantity,
            dispatchDeadline: values.dispatchDeadline,
            carrier: values.carrier,
            raw: values.raw,
          },
        });
    }
    const newLines = lines.filter((l) => !existing.has(`CQ|${l.lineId}`)).length;
    const orders = new Set(lines.map((l) => `${l.retailer}|${l.orderNumber}`)).size;
    const units = lines.reduce((n, l) => n + l.quantity, 0);
    const newProducts = inserted.length;
    await this.db.insert(notifications).values({
      kind: 'VENTAS_RECIBIDAS',
      title: newLines ? `${sender.name} te envió ${orders} ${orders === 1 ? 'venta' : 'ventas'}` : `${sender.name} actualizó ${orders} ${orders === 1 ? 'venta' : 'ventas'}`,
      body:
        `${units} ${units === 1 ? 'unidad' : 'unidades'}` +
        (newProducts ? ` · ${newProducts} ${newProducts === 1 ? 'producto nuevo' : 'productos nuevos'} por configurar (precio, SKU padre/color)` : ''),
      link: newProducts ? '/productos?tab=clientes' : `/ventas?retailer=${code}`,
      data: { from: sender.name, code, orders, units, newProducts },
    });
    return { newLines, updatedLines: lines.length - newLines, newProducts };
  }

  // ------------------------------------------------------------------ Proveedor: productos de sus clientes

  /** Productos que llegaron de clientes de Cuadra, con su SKU padre/color, nombre, precio y producto */
  async clientProducts() {
    const { rows } = await this.db.execute<{
      id: string;
      code: string;
      client: string;
      sku: string;
      name: string;
      price: number | null;
      product_id: string | null;
      product_name: string | null;
      parent_sku: string | null;
      own_name: string | null;
      sales: number;
    }>(sql`
      select rp.id, r.code, r.name as client, rp.retailer_sku as sku, rp.name, rp.list_price::float8 as price,
        rp.product_id, p.name as product_name, sn.parent_sku, sn.name as own_name,
        (select coalesce(sum(s.quantity), 0) from sales_records s where s.retailer_id = r.id and upper(s.seller_sku) = upper(rp.retailer_sku))::int as sales
      from retailer_products rp
      join retailers r on r.id = rp.retailer_id
      left join products p on p.id = rp.product_id
      left join retail_sku_names sn on sn.provider = r.code and sn.seller_sku = upper(rp.retailer_sku)
      where r.code like 'CLI-%'
      order by (rp.list_price is null) desc, r.name, rp.name
    `);
    return rows.map((r) => ({
      id: r.id,
      clientCode: r.code,
      client: r.client,
      sku: r.sku,
      name: r.name,
      price: r.price,
      productId: r.product_id,
      productName: r.product_name,
      parentSku: r.parent_sku,
      ownName: r.own_name,
      units: r.sales,
    }));
  }

  /**
   * Guarda lo que el proveedor configura de un producto de cliente: precio neto (sin IVA), SKU padre/color,
   * nombre y su producto (para el costo). El precio se aplica a las ventas de ese producto que aún
   * no tienen documento emitido.
   */
  async updateClientProduct(id: string, input: { price?: number | null; parentSku?: string | null; name?: string | null; productId?: string | null }, user: string) {
    const [row] = await this.db
      .select({ id: retailerProducts.id, retailerId: retailerProducts.retailerId, sku: retailerProducts.retailerSku, code: retailers.code })
      .from(retailerProducts)
      .innerJoin(retailers, eq(retailers.id, retailerProducts.retailerId))
      .where(eq(retailerProducts.id, id));
    if (!row || !row.code.startsWith('CLI-')) throw new NotFoundException('El producto no existe');

    const set: Partial<typeof retailerProducts.$inferInsert> = {};
    if (input.price !== undefined) set.listPrice = input.price === null ? null : String(Math.round(input.price));
    if (input.productId !== undefined) set.productId = input.productId;
    if (Object.keys(set).length) await this.db.update(retailerProducts).set(set).where(eq(retailerProducts.id, id));

    if (input.price !== undefined) {
      const price = input.price === null ? null : String(Math.round(input.price));
      await this.db.execute(sql`
        update sales_records s set paid_price = ${price}, unit_price = ${price}, amounts_include_tax = false
        where s.retailer_id = ${row.retailerId} and upper(s.seller_sku) = upper(${row.sku})
          and not exists (select 1 from customer_receipts cr where cr.retailer_id = s.retailer_id and cr.order_number = s.order_number)
      `);
    }
    if (input.parentSku !== undefined || input.name !== undefined) {
      const sku = row.sku.toUpperCase();
      if (!input.parentSku?.trim()) {
        await this.db.delete(retailSkuNames).where(and(eq(retailSkuNames.provider, row.code), eq(retailSkuNames.sellerSku, sku)));
      } else {
        const values = { provider: row.code, sellerSku: sku, parentSku: input.parentSku.trim().toUpperCase(), name: (input.name?.trim() || row.sku).slice(0, 300), updatedBy: user, updatedAt: new Date() };
        await this.db
          .insert(retailSkuNames)
          .values(values)
          .onConflictDoUpdate({ target: [retailSkuNames.tenantId, retailSkuNames.provider, retailSkuNames.sellerSku], set: values });
      }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ Proveedor: actualizar lo recibido

  /** Clientes de Cuadra que le han enviado ventas a esta empresa */
  async clients() {
    const { rows } = await this.db.execute<{ code: string; name: string; lines: number }>(sql`
      select r.code, r.name, count(s.id)::int as lines
      from retailers r join sales_records s on s.retailer_id = r.id
      where r.code like 'CLI-%' and s.external_item_id like 'CQ|%'
      group by r.code, r.name order by r.name
    `);
    return rows;
  }

  /**
   * Actualiza las ventas ya recibidas de clientes de Cuadra con lo que el cliente tiene hoy:
   * estado (despachada, entregada, cancelada…), fecha de despacho, courier y cantidad.
   * No trae ventas nuevas: solo las que ya llegaron. El SKU, nombre y precio que puso el
   * proveedor no se tocan.
   */
  async refreshFromClients() {
    const { rows } = await this.db.execute<{
      id: string;
      line_id: string;
      sender: string | null;
      client: string;
      status: string | null;
      deadline: string | null;
      carrier: string | null;
      quantity: number;
    }>(sql`
      select s.id, substr(s.external_item_id, 4) as line_id, s.raw->>'from' as sender, r.name as client,
        s.status, s.dispatch_deadline::text as deadline, s.carrier, s.quantity
      from sales_records s join retailers r on r.id = s.retailer_id
      where r.code like 'CLI-%' and s.external_item_id like 'CQ|%'
        and s.order_date >= current_date - 120
    `);
    const bySender = new Map<string, typeof rows>();
    for (const r of rows) if (r.sender) bySender.set(r.sender, [...(bySender.get(r.sender) ?? []), r]);

    const result: { client: string; lines: number; updated: number; cancelled: number; missing: number }[] = [];
    for (const [sender, mine] of bySender) {
      const [t] = await this.base.select({ name: tenants.name, status: tenants.status }).from(tenants).where(eq(tenants.id, sender));
      const client = t?.name ?? mine[0].client;
      if (!t || t.status !== 'ACTIVA') {
        result.push({ client, lines: mine.length, updated: 0, cancelled: 0, missing: mine.length });
        continue;
      }
      // Lo que el cliente tiene hoy de esas líneas (solo las que se le enviaron a esta empresa)
      const ids = mine.map((m) => m.line_id).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      const current = await runInBackground(this.base, sender, async () => {
        if (!ids.length) return [];
        const { rows: cur } = await this.db.execute<{ id: string; code: string; status: string | null; deadline: string | null; carrier: string | null; quantity: number; sent: string | null }>(sql`
          select s.id, r.code, s.status, s.dispatch_deadline::text as deadline, s.carrier, s.quantity, s.sent_to_supplier as sent
          from sales_records s join retailers r on r.id = s.retailer_id
          where s.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
        `);
        return cur;
      });
      const byId = new Map(current.filter((c) => c.sent).map((c) => [c.id, c]));
      let updated = 0;
      let cancelled = 0;
      let missing = 0;
      for (const m of mine) {
        const c = byId.get(m.line_id);
        if (!c) {
          missing++;
          continue;
        }
        const next = {
          status: (c.status ?? m.status ?? 'Pendiente').slice(0, 50),
          dispatchDeadline: c.deadline,
          carrier: courierOf(c.code, c.carrier)?.slice(0, 100) ?? m.carrier,
          quantity: Math.max(1, Number(c.quantity) || 1),
        };
        if (/cancel|anulad/i.test(next.status) && !/cancel|anulad/i.test(m.status ?? '')) cancelled++;
        if (next.status !== m.status || next.dispatchDeadline !== m.deadline || next.carrier !== m.carrier || next.quantity !== Number(m.quantity)) {
          await this.db.update(salesRecords).set(next).where(eq(salesRecords.id, m.id));
          updated++;
        }
      }
      result.push({ client, lines: mine.length, updated, cancelled, missing });
    }
    return { clients: result };
  }

  // ------------------------------------------------------------------ Avisos

  async notifications() {
    const rows = await this.db.select().from(notifications).orderBy(sql`${notifications.createdAt} desc`).limit(30);
    return { unread: rows.filter((n) => !n.readAt).length, items: rows };
  }

  async markRead(ids?: string[]) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(ids?.length ? and(inArray(notifications.id, ids), isNull(notifications.readAt)) : isNull(notifications.readAt));
    return { ok: true };
  }
}
