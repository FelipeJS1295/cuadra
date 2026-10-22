import { arr, findArray, findDeep, http, num, pick, str, toDate } from './util.js';
import { ProviderError, type NormalizedItem, type NormalizedOrder, type NormalizedProduct, type ProviderConfig, type RetailProvider } from './types.js';

/**
 * Paris (Marketplace Cencosud). Documentación: https://developers.ecomm.cencosud.com
 * Autenticación: la API Key (Mi cuenta → Integraciones) se cambia por un token de acceso.
 *
 * Las rutas y nombres de campos se pueden ajustar en Conexión (URL base, rutas) porque
 * el portal de Cencosud no publica la especificación abiertamente; la lectura de los
 * datos es tolerante y se guarda la respuesta completa de cada orden.
 */
const tokens = new Map<string, { token: string; until: number }>();

const base = (cfg: ProviderConfig) => (cfg.settings.baseUrl || 'https://api-developers.ecomm.cencosud.com').replace(/\/+$/, '');

async function token(cfg: ProviderConfig): Promise<string> {
  const apiKey = cfg.secrets.apiKey?.trim();
  if (!apiKey) throw new ProviderError('Falta la API Key de Paris');
  const cached = tokens.get(apiKey);
  if (cached && cached.until > Date.now()) return cached.token;
  const { json } = await http(`${base(cfg)}${cfg.settings.authPath || '/v1/auth/apiKey'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });
  const t = str(pick(json, 'accessToken', 'access_token', 'token', 'data.accessToken'));
  if (!t) throw new ProviderError('Paris no entregó el token de acceso');
  const ttl = (num(pick(json, 'expiresIn', 'expires_in')) ?? 3600) * 1000;
  tokens.set(apiKey, { token: t, until: Date.now() + Math.min(ttl, 3600000) - 60000 });
  return t;
}

async function get(cfg: ProviderConfig, path: string) {
  const t = await token(cfg);
  const { json } = await http(`${base(cfg)}${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(cfg.settings.sellerId ? { 'x-seller-id': cfg.settings.sellerId } : {}) },
    timeoutMs: 90000,
  });
  return json as Record<string, unknown>;
}

function normalizeItem(i: Record<string, unknown>, n: number): NormalizedItem {
  const qty = num(pick(i, 'quantity', 'qty')) ?? 1;
  const paid = num(pick(i, 'priceAfterDiscounts', 'paidPrice', 'grossPrice', 'price', 'basePrice'));
  return {
    externalItemId: String(pick(i, 'id', 'itemId', 'subOrderItemId', 'sku') ?? n),
    sellerSku: str(pick(i, 'sellerSku', 'sku.sellerSku', 'skuSeller', 'sku')),
    retailerSku: str(pick(i, 'skuId', 'sku.id', 'productId')),
    name: str(pick(i, 'name', 'productName', 'sku.name', 'description')),
    quantity: qty,
    unitPrice: paid !== null && qty ? paid / qty : paid,
    paidPrice: paid,
    shippingAmount: num(pick(i, 'shippingCost', 'shipping.cost')),
    status: str(pick(i, 'status.name', 'status')),
    raw: i,
  };
}

function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  // Las órdenes de Paris traen sub-órdenes (una por vendedor/despacho) con sus productos
  const subOrders = arr(pick(o, 'subOrders', 'suborders'));
  const rawItems = subOrders.length ? subOrders.flatMap((s) => arr(pick(s, 'items', 'products'))) : arr(pick(o, 'items', 'products'));
  const items = rawItems.map(normalizeItem);
  const shipping =
    subOrders.reduce((n, s) => n + (num(pick(s, 'shippingCost', 'cost', 'shipping.cost')) ?? 0), 0) || num(pick(o, 'shippingCost', 'shipping.cost'));
  const productTotal = items.reduce((n, i) => n + (i.paidPrice ?? 0), 0);
  return {
    externalId: String(pick(o, 'id', 'orderId', 'originOrderNumber', 'orderNumber')),
    orderNumber: str(pick(o, 'originOrderNumber', 'orderNumber', 'subOrders.0.subOrderNumber', 'id')),
    customerOrderId: str(pick(o, 'subOrders.0.subOrderNumber')),
    orderDate: toDate(pick(o, 'createdAt', 'originOrderDate', 'orderDate', 'created_at')),
    status: str(pick(o, 'status.name', 'status', 'subOrders.0.status.name')),
    customerName: str(pick(o, 'customer.name', 'customer.fullName', 'billingAddress.name', 'shippingAddress.name')),
    customerRut: str(pick(o, 'customer.documentNumber', 'billingAddress.documentNumber')) ?? findDeep(o, /^(rut|documentNumber|taxId)$/i),
    customerEmail: str(pick(o, 'customer.email', 'email')),
    address: str(pick(o, 'shippingAddress.address', 'shippingAddress.street', 'billingAddress.address')),
    commune: str(pick(o, 'shippingAddress.communaCode', 'shippingAddress.commune', 'shippingAddress.city')),
    region: str(pick(o, 'shippingAddress.regionCode', 'shippingAddress.region')),
    total: items.length ? productTotal + (shipping ?? 0) : num(pick(o, 'total', 'totalPrice', 'grossTotal')),
    shippingTotal: shipping,
    items,
    raw: o,
  };
}

export const paris: RetailProvider = {
  code: 'CENCOSUD',
  label: 'Paris',
  howTo:
    'En Marketplace Cencosud (Paris): Mi cuenta → Integraciones. Ahí está tu API Key (si no aparece, pide por ticket el cambio a "Integrador / propio desarrollo"). La documentación está en developers.ecomm.cencosud.com.',
  docsUrl: 'https://developers.ecomm.cencosud.com/',
  fields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true },
    { key: 'sellerId', label: 'Seller ID (opcional)' },
    { key: 'baseUrl', label: 'URL de la API', default: 'https://api-developers.ecomm.cencosud.com' },
    { key: 'authPath', label: 'Ruta del token', default: '/v1/auth/apiKey', help: 'Ajustable si la documentación de Cencosud indica otra' },
    { key: 'ordersPath', label: 'Ruta de órdenes', default: '/v1/orders' },
    { key: 'productsPath', label: 'Ruta de productos', default: '/v1/products' },
  ],

  async test(cfg) {
    await token(cfg);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const body = await get(cfg, `${cfg.settings.ordersPath || '/v1/orders'}?gteCreatedAt=${from}&lteCreatedAt=${to}&limit=1&offset=0`);
    const count = pick(body, 'count', 'total', 'totalCount', 'meta.total');
    return { message: `Conexión OK${count !== null ? `: ${count} órdenes en los últimos 7 días` : ''}`, sample: body };
  },

  async orders(cfg, from, to, progress) {
    const out: NormalizedOrder[] = [];
    const limit = 50;
    for (let offset = 0; offset < 20000; offset += limit) {
      const body = await get(cfg, `${cfg.settings.ordersPath || '/v1/orders'}?gteCreatedAt=${from}&lteCreatedAt=${to}&limit=${limit}&offset=${offset}`);
      const page = findArray(body);
      out.push(...page.map(normalizeOrder));
      progress(`Paris: ${out.length} órdenes leídas…`);
      const total = num(pick(body, 'count', 'total', 'totalCount', 'meta.total'));
      if (page.length < limit || (total !== null && out.length >= total)) break;
    }
    return out;
  },

  async products(cfg, progress) {
    const out: NormalizedProduct[] = [];
    const limit = 100;
    for (let offset = 0; offset < 50000; offset += limit) {
      const body = await get(cfg, `${cfg.settings.productsPath || '/v1/products'}?limit=${limit}&offset=${offset}`);
      const page = findArray(body);
      for (const p of page) {
        const sku = str(pick(p, 'sellerSku', 'skuSeller', 'sku', 'variants.0.sellerSku'));
        if (!sku) continue;
        out.push({
          sellerSku: sku,
          retailerSku: str(pick(p, 'skuId', 'id', 'productId')),
          name: str(pick(p, 'name', 'productName', 'title')),
          brand: str(pick(p, 'brand.name', 'brand')),
          price: num(pick(p, 'price', 'listPrice', 'prices.listPrice')),
          salePrice: num(pick(p, 'salePrice', 'offerPrice', 'prices.offerPrice')),
          stock: num(pick(p, 'stock', 'quantity', 'inventory.quantity')),
          status: str(pick(p, 'status.name', 'status')),
          url: str(pick(p, 'url', 'link')),
          imageUrl: str(pick(p, 'image', 'imageUrl', 'images.0.url', 'images.0')),
          raw: p,
        });
      }
      progress(`Paris: ${out.length} productos leídos…`);
      const total = num(pick(body, 'count', 'total', 'totalCount'));
      if (page.length < limit || (total !== null && offset + limit >= total)) break;
    }
    return out;
  },
};
