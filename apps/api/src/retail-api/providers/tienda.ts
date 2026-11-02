import { arr, http, num, pick, str, toDate } from './util.js';
import {
  ProviderError,
  type NormalizedItem,
  type NormalizedOrder,
  type NormalizedProduct,
  type NormalizedSettlement,
  type ProviderConfig,
  type RetailProvider,
} from './types.js';

/**
 * Tienda web propia (ej. jamaroff.cl). La tienda expone /api/cuadra con una clave compartida
 * (CUADRA_API_KEY en la tienda = "Clave de conexión" aquí):
 *   GET  /api/cuadra                         prueba
 *   GET  /api/cuadra/pedidos?desde=&hasta=   pedidos pagados con sus productos
 *   GET  /api/cuadra/productos               productos publicados
 *   POST /api/cuadra/productos               publicar / actualizar (lo usa "Tienda web" en Productos)
 *   GET  /api/cuadra/categorias
 */
export const storeBase = (cfg: ProviderConfig) => {
  const b = cfg.settings.baseUrl?.trim().replace(/\/+$/, '');
  if (!b) throw new ProviderError('Falta la dirección de la tienda (ej: https://jamaroff.cl)');
  return /^https?:\/\//.test(b) ? b : `https://${b}`;
};

export async function storeCall(cfg: ProviderConfig, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const key = cfg.secrets.apiKey?.trim();
  if (!key) throw new ProviderError('Falta la clave de conexión de la tienda');
  const { json } = await http(`${storeBase(cfg)}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    timeoutMs: init.timeoutMs ?? 90000,
  });
  return (json ?? {}) as Record<string, unknown>;
}

/** Estado de la tienda en palabras que Cuadra entiende (pagado → pendiente de preparar, etc.) */
const STATUS: Record<string, string> = {
  pendiente_pago: 'Pendiente de pago',
  pagado: 'Pagado, por preparar',
  en_fabricacion: 'En preparación (fabricación)',
  listo_despacho: 'Listo para despacho',
  despachado: 'Despachado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

const addDays = (d: Date, n: number) => {
  const x = new Date(d.getTime() + n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(x);
};

function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  const status = String(pick(o, 'status') ?? '');
  const label = STATUS[status] ?? status;
  const subtotal = num(pick(o, 'subtotal')) ?? 0;
  const discount = num(pick(o, 'discount')) ?? 0;
  const shipping = num(pick(o, 'shippingCost')) ?? 0;
  // El descuento (cupón) es del pedido: se reparte entre los productos según su precio
  const factor = subtotal > 0 ? Math.max(0, subtotal - discount) / subtotal : 1;
  const paidAt = toDate(pick(o, 'paidAt')) ?? toDate(pick(o, 'createdAt'));
  const pickup = pick(o, 'delivery.method') === 'retiro';
  const items: NormalizedItem[] = arr<Record<string, unknown>>(pick(o, 'items')).map((i, n) => {
    const qty = num(pick(i, 'quantity')) ?? 1;
    const unit = (num(pick(i, 'unitPrice')) ?? 0) * factor;
    const variant = str(pick(i, 'variantName'));
    // A pedido: se despacha cuando termina la fabricación; en stock, a los 2 días de pagado
    const lead = pick(i, 'mode') === 'pedido' ? (num(pick(i, 'leadTimeDays')) ?? 15) : 2;
    return {
      externalItemId: String(pick(i, 'id') ?? n),
      sellerSku: str(pick(i, 'sku')) ?? (pick(i, 'productId') ? `WEB-${String(pick(i, 'productId'))}` : null),
      retailerSku: pick(i, 'productId') !== null ? String(pick(i, 'productId')) : null,
      name: [str(pick(i, 'name')), variant].filter(Boolean).join(' · ') || null,
      quantity: qty,
      unitPrice: Math.round(unit),
      paidPrice: Math.round(unit * qty),
      // El despacho que pagó el cliente va en la primera línea
      shippingAmount: n === 0 ? shipping : 0,
      status: label,
      dispatchDeadline: paidAt && !pickup ? addDays(paidAt, lead) : null,
      carrier: pickup ? 'Retiro en tienda' : str(pick(o, 'carrier')),
      raw: i,
    };
  });
  return {
    externalId: String(pick(o, 'id')),
    orderNumber: str(pick(o, 'number')),
    customerOrderId: null,
    orderDate: toDate(pick(o, 'createdAt')),
    dispatchDeadline: items[0]?.dispatchDeadline ?? null,
    carrier: pickup ? 'Retiro en tienda' : str(pick(o, 'carrier')),
    status: label,
    customerName: str(pick(o, 'invoice.razonSocial')) ?? str(pick(o, 'customer.name')),
    customerRut: str(pick(o, 'invoice.rut')) ?? str(pick(o, 'customer.rut')),
    customerEmail: str(pick(o, 'customer.email')),
    address: str(pick(o, 'delivery.address')),
    commune: str(pick(o, 'delivery.comuna')),
    region: str(pick(o, 'delivery.region')),
    total: num(pick(o, 'total')),
    shippingTotal: shipping,
    items,
    raw: o,
  };
}

export const tienda: RetailProvider = {
  code: 'TIENDA',
  label: 'Tienda web',
  howTo:
    'En el servidor de la tienda, agrega CUADRA_API_KEY=<una clave larga> al archivo .env y reiníciala. Aquí pon la dirección de la tienda (ej: https://jamaroff.cl) y esa misma clave.',
  docsUrl: '',
  fields: [
    { key: 'baseUrl', label: 'Dirección de la tienda', placeholder: 'https://jamaroff.cl', required: true },
    { key: 'apiKey', label: 'Clave de conexión (CUADRA_API_KEY)', secret: true, required: true },
  ],

  async test(cfg) {
    const body = await storeCall(cfg, '/api/cuadra');
    return {
      message: `Conectado con ${str(pick(body, 'store')) ?? 'la tienda'}: ${num(pick(body, 'products')) ?? 0} productos, ${num(pick(body, 'paidOrders')) ?? 0} pedidos pagados`,
      sample: body,
    };
  },

  async orders(cfg, from, to, progress) {
    const out: NormalizedOrder[] = [];
    // De a 31 días por consulta
    for (let start = new Date(`${from}T12:00:00Z`); start <= new Date(`${to}T12:00:00Z`); start.setUTCDate(start.getUTCDate() + 31)) {
      const a = start.toISOString().slice(0, 10);
      const endD = new Date(start.getTime() + 30 * 86400000);
      const b = endD.toISOString().slice(0, 10) < to ? endD.toISOString().slice(0, 10) : to;
      progress(`Buscando pedidos de la tienda del ${a} al ${b}…`);
      const body = await storeCall(cfg, `/api/cuadra/pedidos?desde=${a}&hasta=${b}`);
      out.push(...arr<Record<string, unknown>>(pick(body, 'orders')).map(normalizeOrder));
    }
    return out;
  },

  /**
   * Pago de cada pedido: en la tienda el cliente paga al comprar (Webpay o transferencia), así que la
   * venta queda pagada completa (productos + despacho) el día del pago. Los reembolsados no suman.
   */
  async settlements(_cfg, _from, _to, _progress, orders) {
    const out: NormalizedSettlement[] = [];
    for (const o of orders) {
      const raw = o.raw as Record<string, unknown>;
      if (pick(raw, 'paymentStatus') !== 'pagado') continue;
      const paid = toDate(pick(raw, 'paidAt')) ?? o.orderDate;
      out.push({
        lineKey: `WEB|${o.externalId}|PAGO`,
        orderNumber: o.orderNumber,
        saleItemId: o.orderNumber,
        sellerSku: o.items[0]?.sellerSku ?? null,
        productName: o.items[0]?.name ?? null,
        kind: 'PRODUCT_PAYMENT',
        transactionType: pick(raw, 'paymentMethod') === 'transferencia' ? 'Transferencia' : 'Webpay',
        transactionDate: paid ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(paid) : null,
        amountGross: Math.round(o.total ?? 0),
        paymentStatus: 'pagado',
        statementNumber: o.orderNumber,
        raw: { paymentMethod: pick(raw, 'paymentMethod'), paidAt: pick(raw, 'paidAt'), total: pick(raw, 'total') },
      });
    }
    return out;
  },

  async products(cfg) {
    const body = await storeCall(cfg, '/api/cuadra/productos');
    return arr<Record<string, unknown>>(pick(body, 'products'))
      .filter((p) => str(pick(p, 'sku')))
      .map((p): NormalizedProduct => {
        const price = num(pick(p, 'price'));
        const before = num(pick(p, 'compareAtPrice'));
        return {
          sellerSku: str(pick(p, 'sku'))!,
          retailerSku: String(pick(p, 'id')),
          name: str(pick(p, 'name')),
          brand: null,
          price: before && price && before > price ? before : price,
          salePrice: before && price && before > price ? price : null,
          stock: num(pick(p, 'stock')),
          status: pick(p, 'active') === false ? 'Oculto' : 'Publicado',
          url: str(pick(p, 'url')),
          imageUrl: str(pick(p, 'image')),
          raw: p,
        };
      });
  },
};
