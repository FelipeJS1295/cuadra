import { createHmac } from 'node:crypto';
import { arr, dayRange, http, num, pick, str, toDate } from './util.js';
import { ProviderError, type NormalizedItem, type NormalizedOrder, type NormalizedProduct, type ProviderConfig, type RetailProvider } from './types.js';

/** RFC 3986 (como pide Falabella para firmar) */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** "2026-10-21T13:05:09+00:00" */
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * Falabella Seller Center API (https://developers.falabella.com).
 * Cada llamada lleva Action, UserID, Version, Format, Timestamp y Signature =
 * HMAC-SHA256(API Key, parámetros ordenados y codificados).
 */
async function call(cfg: ProviderConfig, action: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const userId = cfg.settings.userId?.trim();
  const apiKey = cfg.secrets.apiKey?.trim();
  if (!userId || !apiKey) throw new ProviderError('Faltan el usuario (correo) y la API Key de Falabella');
  const all: Record<string, string> = { Action: action, Format: 'JSON', Timestamp: isoSeconds(new Date()), UserID: userId, Version: '1.0', ...params };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join('&');
  const signature = createHmac('sha256', apiKey).update(query).digest('hex');
  const base = (cfg.settings.baseUrl || 'https://sellercenter-api.falabella.com').replace(/\/+$/, '');
  const sellerId = (cfg.settings.sellerId || 'SELLER').replace(/[^\w-]/g, '');
  const { json } = await http(`${base}/?${query}&Signature=${signature}`, {
    headers: { Accept: 'application/json', 'User-Agent': `${sellerId}/Node/${process.versions.node}/PROPIA/FACL` },
    timeoutMs: 90000,
  });
  const body = (json ?? {}) as Record<string, unknown>;
  const error = pick(body, 'ErrorResponse.Head.ErrorMessage');
  if (error) throw new ProviderError(`Falabella: ${String(error)} (código ${String(pick(body, 'ErrorResponse.Head.ErrorCode') ?? '?')})`);
  return body;
}

/**
 * Órdenes de una respuesta. En JSON, Falabella a veces anida cada orden dentro de "Order"
 * ({ Orders: [{ Order: {...} }] }) y a veces no ({ Orders: { Order: [...] } }).
 */
function ordersOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return arr<Record<string, unknown>>(pick(body, 'SuccessResponse.Body.Orders.Order', 'SuccessResponse.Body.Orders')).flatMap((o) =>
    'Order' in o && !('OrderId' in o) ? arr<Record<string, unknown>>(o.Order) : [o],
  );
}

const orderId = (o: Record<string, unknown>) => {
  const id = str(pick(o, 'OrderId', 'orderId', 'OrderID'));
  return id && /^\d+$/.test(id) ? id : null;
};

const orderItems = (o: Record<string, unknown>): NormalizedItem[] =>
  arr(pick(o, 'OrderItems.OrderItem', 'OrderItems')).map((i) => ({
    externalItemId: String(pick(i, 'OrderItemId') ?? pick(i, 'Sku')),
    sellerSku: str(pick(i, 'Sku', 'SellerSku')),
    retailerSku: str(pick(i, 'ShopSku')),
    name: str(pick(i, 'Name')),
    quantity: 1,
    unitPrice: num(pick(i, 'ItemPrice')),
    paidPrice: num(pick(i, 'PaidPrice', 'ItemPrice')),
    shippingAmount: num(pick(i, 'ShippingAmount')),
    status: str(pick(i, 'Status')),
    raw: i,
  }));

function normalizeOrder(o: Record<string, unknown>, items: NormalizedItem[]): NormalizedOrder {
  const rawStatus = pick(o, 'Statuses.Status', 'Statuses');
  const statuses = (Array.isArray(rawStatus) ? rawStatus : rawStatus !== null && typeof rawStatus !== 'object' ? [rawStatus] : []).map(String);
  const name = [str(pick(o, 'CustomerFirstName')), str(pick(o, 'CustomerLastName'))].filter(Boolean).join(' ');
  const shipping = items.reduce((n, i) => n + (i.shippingAmount ?? 0), 0);
  const paid = items.reduce((n, i) => n + (i.paidPrice ?? 0), 0);
  return {
    externalId: orderId(o) ?? String(pick(o, 'OrderNumber')),
    orderNumber: str(pick(o, 'OrderNumber')),
    customerOrderId: null,
    orderDate: toDate(pick(o, 'CreatedAt')),
    status: statuses.join(', ') || str(pick(o, 'Status')),
    customerName: name || str(pick(o, 'AddressBilling.FirstName')),
    customerRut: str(pick(o, 'NationalRegistrationNumber', 'AddressBilling.CustomerTaxId', 'ExtraBillingAttributes.LegalId')),
    customerEmail: str(pick(o, 'AddressBilling.CustomerEmail', 'AddressShipping.CustomerEmail')),
    address: [str(pick(o, 'AddressShipping.Address1')), str(pick(o, 'AddressShipping.Address2'))].filter(Boolean).join(' ') || null,
    commune: str(pick(o, 'AddressShipping.City', 'AddressShipping.Ward')),
    region: str(pick(o, 'AddressShipping.Region')),
    total: items.length ? paid + shipping : num(pick(o, 'Price')),
    shippingTotal: items.length ? shipping : null,
    items,
    raw: o,
  };
}

export const falabella: RetailProvider = {
  code: 'FALABELLA',
  label: 'Falabella',
  howTo:
    'En Seller Center de Falabella: Mi cuenta → Administrar usuarios. Tu "User ID" es el correo con que entras y la API Key aparece en la columna "API Key" de tu usuario. El Seller ID está en Mi cuenta → Configuración.',
  docsUrl: 'https://developers.falabella.com/v600/reference',
  fields: [
    { key: 'userId', label: 'User ID (correo de Seller Center)', required: true, placeholder: 'ventas@jamaroff.cl' },
    { key: 'apiKey', label: 'API Key', secret: true, required: true },
    { key: 'sellerId', label: 'Seller ID', placeholder: 'Ej: SC1A2B3', help: 'Se envía en el encabezado User-Agent, como pide Falabella' },
    { key: 'baseUrl', label: 'URL de la API', default: 'https://sellercenter-api.falabella.com' },
  ],

  async test(cfg) {
    const { start, end } = dayRange(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    const body = await call(cfg, 'GetOrders', { CreatedAfter: isoSeconds(start), CreatedBefore: isoSeconds(end), Limit: '1' });
    const total = pick(body, 'SuccessResponse.Head.TotalCount');
    return { message: `Conexión OK${total !== null ? `: ${total} órdenes en los últimos 30 días` : ''}`, sample: pick(body, 'SuccessResponse.Body') };
  },

  /**
   * Órdenes con la misma llamada que la prueba de conexión (GetOrders) y los productos de
   * cada orden con GetOrderItems (una orden por llamada: evita el error E056 de las listas).
   */
  async orders(cfg, from, to, progress) {
    const { start, end } = dayRange(from, to);
    const orders: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 20000; offset += 100) {
      const body = await call(cfg, 'GetOrders', { CreatedAfter: isoSeconds(start), CreatedBefore: isoSeconds(end), Limit: '100', Offset: String(offset) });
      const page = ordersOf(body);
      orders.push(...page);
      progress(`Falabella: ${orders.length} órdenes leídas…`);
      if (page.length < 100) break;
    }
    const valid = orders.filter((o) => orderId(o));
    if (orders.length && !valid.length) {
      throw new ProviderError(`Falabella devolvió órdenes sin OrderId reconocible. Campos: ${Object.keys(orders[0]).slice(0, 20).join(', ')}`);
    }
    const result: NormalizedOrder[] = [];
    let failed = 0;
    for (const [n, o] of valid.entries()) {
      let items: NormalizedItem[] = [];
      try {
        const body = await call(cfg, 'GetOrderItems', { OrderId: orderId(o)! });
        items = orderItems((pick(body, 'SuccessResponse.Body') ?? {}) as Record<string, unknown>);
      } catch {
        // Sin productos igual se guarda la orden (con el total que informa Falabella)
        failed++;
      }
      result.push(normalizeOrder(o, items));
      if (n % 5 === 4 || n === valid.length - 1) {
        progress(`Falabella: productos de ${n + 1} de ${valid.length} órdenes…${failed ? ` (${failed} sin detalle)` : ''}`);
      }
    }
    return result;
  },

  async products(cfg, progress) {
    const out: NormalizedProduct[] = [];
    for (let offset = 0; offset < 50000; offset += 500) {
      const body = await call(cfg, 'GetProducts', { Filter: 'all', Limit: '500', Offset: String(offset) });
      const page = arr(pick(body, 'SuccessResponse.Body.Products.Product', 'SuccessResponse.Body.Products'));
      for (const p of page) {
        // Precio y stock pueden venir por unidad de negocio (Falabella Chile = facl)
        const units = arr(pick(p, 'BusinessUnits.BusinessUnit', 'BusinessUnits'));
        const bu = units.find((u) => String(pick(u, 'OperatorCode') ?? '').toLowerCase() === 'facl') ?? units[0] ?? {};
        const sku = str(pick(p, 'SellerSku'));
        if (!sku) continue;
        out.push({
          sellerSku: sku,
          retailerSku: str(pick(p, 'ShopSku')),
          name: str(pick(p, 'Name')),
          brand: str(pick(p, 'Brand')),
          price: num(pick(bu, 'Price') ?? pick(p, 'Price')),
          salePrice: num(pick(bu, 'SpecialPrice') ?? pick(p, 'SalePrice', 'SpecialPrice')),
          stock: num(pick(bu, 'Stock') ?? pick(p, 'Quantity', 'Stock')),
          status: str(pick(bu, 'Status') ?? pick(p, 'Status')),
          url: str(pick(p, 'Url')),
          imageUrl: str(pick(p, 'MainImage', 'Images.Image')),
          raw: p,
        });
      }
      progress(`Falabella: ${out.length} productos leídos…`);
      if (page.length < 500) break;
    }
    return out;
  },
};
