import { randomUUID } from 'node:crypto';
import { arr, dayRange, findDeep, http, num, pick, str, toDate } from './util.js';
import { ProviderError, type NormalizedItem, type NormalizedOrder, type NormalizedProduct, type ProviderConfig, type RetailProvider } from './types.js';

/**
 * Walmart Marketplace API, mercado Chile (WM_MARKET: cl).
 * Token: POST /v3/token con Client ID y Client Secret (dura 15 minutos).
 */
const tokens = new Map<string, { token: string; until: number }>();

function base(cfg: ProviderConfig) {
  return (cfg.settings.baseUrl || 'https://marketplace.walmartapis.com').replace(/\/+$/, '');
}

function basicAuth(cfg: ProviderConfig) {
  const id = cfg.settings.clientId?.trim();
  const secret = cfg.secrets.clientSecret?.trim();
  if (!id || !secret) throw new ProviderError('Faltan el Client ID y el Client Secret de Walmart');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

function headers(cfg: ProviderConfig): Record<string, string> {
  return {
    Authorization: basicAuth(cfg),
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': randomUUID(),
    WM_MARKET: 'cl',
    Accept: 'application/json',
    ...(cfg.settings.channelType ? { 'WM_CONSUMER.CHANNEL.TYPE': cfg.settings.channelType } : {}),
  };
}

async function token(cfg: ProviderConfig): Promise<string> {
  const key = `${cfg.settings.clientId}:${base(cfg)}`;
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const { json } = await http(`${base(cfg)}/v3/token`, {
    method: 'POST',
    headers: { ...headers(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const t = str(pick(json, 'access_token', 'accessToken'));
  if (!t) throw new ProviderError('Walmart no entregó el token de acceso');
  const ttl = (num(pick(json, 'expires_in')) ?? 900) * 1000;
  tokens.set(key, { token: t, until: Date.now() + ttl - 60000 });
  return t;
}

async function put(cfg: ProviderConfig, path: string, body: unknown) {
  const t = await token(cfg);
  const { json } = await http(`${base(cfg)}${path}`, {
    method: 'PUT',
    headers: { ...headers(cfg), 'WM_SEC.ACCESS_TOKEN': t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 60000,
  });
  return (json ?? {}) as Record<string, unknown>;
}

async function get(cfg: ProviderConfig, path: string) {
  const t = await token(cfg);
  const { json } = await http(`${base(cfg)}${path}`, { headers: { ...headers(cfg), 'WM_SEC.ACCESS_TOKEN': t }, timeoutMs: 90000 });
  return (json ?? {}) as Record<string, unknown>;
}

/** Reintenta cuando Walmart responde un error temporal (5xx, 429) */
async function retry<T>(fn: () => Promise<T>, progress: (m: string) => void, tries = 4): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof ProviderError ? (err.status ?? 0) : 0;
      if (n >= tries || !(status >= 500 || status === 429)) throw err;
      progress(`Walmart respondió ${status}: reintentando (${n}/${tries - 1})…`);
      await new Promise((r) => setTimeout(r, 2000 * n));
    }
  }
}

/** Monto con IVA de un cargo (Walmart separa monto e impuesto) */
const gross = (c: Record<string, unknown>) => (num(pick(c, 'chargeAmount.amount')) ?? 0) + (num(pick(c, 'tax.taxAmount.amount')) ?? 0);

function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  const items: NormalizedItem[] = arr(pick(o, 'orderLines.orderLine')).map((l) => {
    const charges = arr(pick(l, 'charges.charge'));
    const product = charges.filter((c) => String(pick(c, 'chargeType')).toUpperCase() === 'PRODUCT').reduce((n, c) => n + gross(c), 0);
    const shipping = charges.filter((c) => String(pick(c, 'chargeType')).toUpperCase() === 'SHIPPING').reduce((n, c) => n + gross(c), 0);
    const qty = num(pick(l, 'orderLineQuantity.amount')) ?? 1;
    const statuses = arr(pick(l, 'orderLineStatuses.orderLineStatus'));
    return {
      externalItemId: String(pick(l, 'lineNumber') ?? pick(l, 'item.sku')),
      sellerSku: str(pick(l, 'item.sku')),
      retailerSku: null,
      name: str(pick(l, 'item.productName')),
      quantity: qty,
      unitPrice: qty ? product / qty : product,
      paidPrice: product,
      shippingAmount: shipping,
      status: statuses.map((s) => str(pick(s, 'status'))).filter(Boolean).join(', ') || null,
      // Entregada: fecha del estado "Delivered" si Walmart la informa
      deliveredAt: (() => {
        const d = statuses.find((s) => /deliver/i.test(String(pick(s, 'status') ?? '')));
        return d ? toDate(pick(d, 'statusDate', 'deliveredDate', 'trackingInfo.shipDateTime')) : null;
      })(),
      raw: l,
    };
  });
  const shippingTotal = items.reduce((n, i) => n + (i.shippingAmount ?? 0), 0);
  const productTotal = items.reduce((n, i) => n + (i.paidPrice ?? 0), 0);
  return {
    externalId: String(pick(o, 'purchaseOrderId')),
    orderNumber: str(pick(o, 'purchaseOrderId')),
    customerOrderId: str(pick(o, 'customerOrderId')),
    orderDate: toDate(pick(o, 'orderDate')),
    status: [...new Set(items.map((i) => i.status).filter(Boolean))].join(', ') || null,
    customerName: str(pick(o, 'shippingInfo.postalAddress.name')),
    // Chile: el RUT puede venir en distintos campos según la versión de la API
    // Chile: el RUT viene en customerRfc
    customerRut: str(pick(o, 'customerRfc')) ?? findDeep(o, /^(rut|customerRfc|documentNumber|taxId|nationalId|buyerTaxId)$/i),
    customerEmail: str(pick(o, 'customerEmailId')),
    address: [str(pick(o, 'shippingInfo.postalAddress.address1')), str(pick(o, 'shippingInfo.postalAddress.address2'))].filter(Boolean).join(' ') || null,
    commune: str(pick(o, 'shippingInfo.postalAddress.city')),
    region: str(pick(o, 'shippingInfo.postalAddress.state')),
    total: productTotal + shippingTotal,
    shippingTotal,
    items,
    raw: o,
  };
}

export const walmart: RetailProvider = {
  code: 'WALMART',
  label: 'Walmart',
  howTo:
    'En Seller Center de Walmart Chile: Configuración → Credenciales de API (o el manual "¿Cómo generar credenciales de autenticación para ejecutar las APIs de Walmart Chile?" de Marketplace Learn). Copia el Client ID y el Client Secret de producción.',
  docsUrl: 'https://developer.walmart.com/cl-marketplace',
  fields: [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    { key: 'channelType', label: 'Consumer Channel Type (opcional)', help: 'Solo si Walmart te lo entregó al registrar la integración' },
    { key: 'baseUrl', label: 'URL de la API', default: 'https://marketplace.walmartapis.com' },
  ],

  async test(cfg) {
    await token(cfg);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const body = await get(cfg, `/v3/orders?createdStartDate=${encodeURIComponent(since)}&limit=1`);
    const total = pick(body, 'list.meta.totalCount');
    return { message: `Conexión OK${total !== null ? `: ${total} órdenes en los últimos 30 días` : ''}`, sample: body };
  },

  /**
   * Igual que la prueba de conexión (que sí funciona): solo createdStartDate y páginas
   * chicas. El fin del rango se filtra aquí, sin mandarlo a Walmart.
   */
  async orders(cfg, from, to, progress) {
    const { start, end } = dayRange(from, to);
    const out: NormalizedOrder[] = [];
    const seen = new Set<string>();
    const query = `createdStartDate=${encodeURIComponent(start.toISOString())}&limit=10`;
    let cursor: string | null = null;
    let read = 0;
    for (let page = 0; page < 1000; page++) {
      // Chile entrega un cursor opaco ("0%3A1~0%3A0", ya codificado) que va en &cursor=
      const path: string = cursor?.startsWith('?') ? `/v3/orders${cursor}` : `/v3/orders?${query}${cursor ? `&cursor=${cursor}` : ''}`;
      const body = await retry(() => get(cfg, path), progress);
      const orders = arr(pick(body, 'list.elements.order'));
      read += orders.length;
      for (const o of orders.map(normalizeOrder)) {
        if (seen.has(o.externalId) || (o.orderDate && o.orderDate > end)) continue;
        seen.add(o.externalId);
        out.push(o);
      }
      const total = num(pick(body, 'list.meta.totalCount'));
      progress(`Walmart: ${read}${total !== null ? ` de ${total}` : ''} órdenes leídas…`);
      const next = str(pick(body, 'list.meta.nextCursor'));
      if (!next || !orders.length || next === cursor || (total !== null && read >= total)) break;
      cursor = next;
    }
    return out;
  },

  async products(cfg, progress) {
    const out: NormalizedProduct[] = [];
    let cursor = '*';
    for (let page = 0; page < 1000; page++) {
      const body = await get(cfg, `/v3/items?limit=50&nextCursor=${encodeURIComponent(cursor)}`);
      const items = arr(pick(body, 'ItemResponse', 'itemResponse', 'items'));
      for (const p of items) {
        const sku = str(pick(p, 'sku'));
        if (!sku) continue;
        out.push({
          sellerSku: sku,
          retailerSku: str(pick(p, 'wpid', 'itemId')),
          name: str(pick(p, 'productName')),
          brand: str(pick(p, 'brand')),
          price: num(pick(p, 'price.amount', 'price')),
          salePrice: null,
          stock: null,
          status: [str(pick(p, 'publishedStatus')), str(pick(p, 'lifecycleStatus'))].filter(Boolean).join(' · ') || null,
          url: null,
          imageUrl: null,
          raw: p,
        });
      }
      progress(`Walmart: ${out.length} productos leídos…`);
      const next = str(pick(body, 'nextCursor'));
      if (!next || !items.length || next === cursor) break;
      cursor = next;
    }
    return out;
  },

  // Walmart Chile por API: stock y precio normal. Nombre, descripción y ofertas van por planilla en Seller Center
  editable: ['stock', 'price'],

  async updateProduct(cfg, target, changes) {
    const done: string[] = [];
    const sku = target.sellerSku;
    if (changes.stock !== undefined) {
      await put(cfg, `/v3/inventory?sku=${encodeURIComponent(sku)}`, { sku, quantity: { unit: 'EACH', amount: Math.max(0, Math.round(changes.stock)) } });
      done.push(`stock ${changes.stock}`);
    }
    if (changes.price !== undefined) {
      await put(cfg, '/v3/price', { sku, pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'CLP', amount: Math.round(changes.price) } }] });
      done.push('precio');
    }
    if (!done.length) throw new ProviderError('Walmart solo permite cambiar stock y precio por API');
    return { status: 'APLICADO' as const, message: `Walmart actualizó: ${done.join(', ')}` };
  },
};
