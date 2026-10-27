import { arr, dayOf, findArray, findDeep, http, httpFile, isPdf, num, pick, str, toDate } from './util.js';
import {
  type LabelOrder,
  type LabelResult,
  ProviderError,
  type NormalizedItem,
  type NormalizedOrder,
  type NormalizedProduct,
  type InvoiceUpload,
  type ProductChanges,
  type ProviderConfig,
  type RetailProvider,
  type UpdateResult,
  type UpdateTarget,
} from './types.js';

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

async function send(cfg: ProviderConfig, method: string, path: string, body?: unknown) {
  const t = await token(cfg);
  const { json } = await http(`${base(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cfg.settings.sellerId ? { 'x-seller-id': cfg.settings.sellerId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: 90000,
  });
  return (json ?? {}) as Record<string, unknown>;
}

const get = (cfg: ProviderConfig, path: string) => send(cfg, 'GET', path);

/** Boletas/facturas ya subidas a Paris para una sub-orden */
async function invoicesOf(cfg: ProviderConfig, orderNumber: string) {
  const path = cfg.settings.invoicePath || '/v1/invoice';
  const body = await get(cfg, `${path}?order_number=${encodeURIComponent(orderNumber)}&limit=20&offset=0`);
  return findArray(body);
}

/** Boletas que Paris ya tiene en cada sub-orden (GET /v1/invoice?order_number=…), de a 5 en paralelo */
async function invoicesFor(cfg: ProviderConfig, orders: { orderNumber: string }[], progress: (m: string) => void) {
  const out = new Map<string, string[]>();
  for (let i = 0; i < orders.length; i += 5) {
    await Promise.all(
      orders.slice(i, i + 5).map(async (o) => {
        // Si falla una orden, queda sin revisar (no se marca como faltante)
        const list = await invoicesOf(cfg, o.orderNumber).catch(() => null);
        if (list)
          out.set(
            o.orderNumber,
            list.map((r) => String(pick(r, 'invoice_number') ?? 'sin N°')),
          );
      }),
    );
    progress(`Revisando boletas en Paris: ${Math.min(i + 5, orders.length)} de ${orders.length}…`);
  }
  return out;
}

/**
 * Sube la boleta a Paris: POST /v1/invoice (multipart) con invoice_number, invoice_type,
 * order_number (la sub-orden), description y el PDF en "file". Paris se la envía al cliente.
 */
async function uploadInvoice(cfg: ProviderConfig, input: InvoiceUpload) {
  if (input.pdf.length > 3 * 1024 * 1024) throw new ProviderError('El PDF pesa más de 3 MB, el máximo que acepta Paris');
  const same = (r: Record<string, unknown>) => String(pick(r, 'invoice_number') ?? '').replace(/^0+/, '') === input.number.replace(/^0+/, '');
  // Si ya está subida (p. ej. a mano en el portal), no se duplica
  const before = await invoicesOf(cfg, input.orderNumber).catch(() => []);
  const found = before.find(same);
  if (found) return { id: str(pick(found, 'id')), already: true, raw: found };

  const form = new FormData();
  form.append('invoice_number', input.number);
  form.append('invoice_type', input.type);
  form.append('order_number', input.orderNumber);
  form.append('description', input.description);
  form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), input.fileName);
  const t = await token(cfg);
  const { json } = await http(`${base(cfg)}${cfg.settings.invoicePath || '/v1/invoice'}`, {
    method: 'POST',
    // Sin Content-Type: fetch pone el multipart con su "boundary"
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(cfg.settings.sellerId ? { 'x-seller-id': cfg.settings.sellerId } : {}) },
    body: form,
    timeoutMs: 90000,
  });
  return { id: str(pick(json, 'id', 'data.id')), already: false, raw: json };
}

/**
 * Etiqueta de despacho de cada sub-orden: GET /v1/sub-orders/{labelId}/print-label (si no
 * responde, /v2/label/print-label/{labelId}). Devuelve el enlace al PDF (Envíame/courier), que
 * se descarga. El labelId viene en la sub-orden; si no, se prueba con su id y su número.
 */
async function labels(cfg: ProviderConfig, orders: LabelOrder[]): Promise<LabelResult> {
  const out: LabelResult = { files: [], problems: [] };
  for (const o of orders) {
    try {
      const subs = arr<Record<string, unknown>>(pick(o.raw, 'subOrders', 'suborders'));
      const sub = subs.find((x) => str(pick(x, 'subOrderNumber', 'number')) === o.orderNumber) ?? subs[0] ?? null;
      const ids = [
        ...new Set(
          [
            str(pick(sub, 'labelId', 'label.id', 'shipment.labelId', 'shipping.labelId')),
            findDeep(sub, /^labelId$/i),
            str(pick(sub, 'id', 'subOrderId')),
            o.orderNumber,
          ].filter((x): x is string => Boolean(x)),
        ),
      ];
      let url: string | null = null;
      let lastError: Error | null = null;
      for (const id of ids) {
        for (const path of [`/v1/sub-orders/${encodeURIComponent(id)}/print-label`, `/v2/label/print-label/${encodeURIComponent(id)}`]) {
          try {
            const body = await get(cfg, path);
            url = str(pick(body, 'data.0.url', 'data.0.labels', 'data.url', 'data.labels', 'url', 'labels'));
            if (url) break;
          } catch (err) {
            lastError = err as Error;
          }
        }
        if (url) break;
      }
      if (!url) throw lastError ?? new ProviderError('Paris no entregó la etiqueta');
      const { data } = await httpFile(url);
      if (!isPdf(data)) throw new ProviderError('El enlace de la etiqueta no es un PDF');
      out.files.push({ orderNumber: o.orderNumber, pdf: data });
    } catch (err) {
      out.problems.push({ orderNumber: o.orderNumber, message: (err as Error).message });
    }
  }
  return out;
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
  // Cada línea guarda su sub-orden: es el N° que usan el reporte de ventas y la liquidación de Paris
  const items = subOrders.length
    ? subOrders.flatMap((s) => {
        // El N° de sub-orden viene en cada producto ("subOrderNumber"); si no, en la sub-orden
        const sub = str(pick(s, 'subOrderNumber', 'subOrderId', 'number'));
        // Lo que pagó el cliente por el envío viene en la sub-orden ("cost"), no en cada producto:
        // se anota en la primera línea de la sub-orden (así la boleta y la venta lo suman una vez)
        const subShipping = num(pick(s, 'shippingCost', 'cost', 'shipping.cost'));
        // Entrega real al cliente (la sub-orden la informa al llegar)
        const deliveredAt = toDate(pick(s, 'effectiveArrivalDate'));
        // Día en que hay que entregarle la sub-orden al courier, y cuál courier (STARKEN…)
        const dispatchDeadline = dayOf(pick(s, 'dispatchDate'));
        const carrier = str(pick(s, 'carrier'));
        const items = arr(pick(s, 'items', 'products')).map((i, n) => ({
          ...normalizeItem(i, n),
          subOrderNumber: str(pick(i, 'subOrderNumber')) ?? sub,
          deliveredAt,
          dispatchDeadline,
          carrier,
        }));
        if (items.length && !items.some((i) => i.shippingAmount) && subShipping) items[0].shippingAmount = subShipping;
        return items;
      })
    : arr(pick(o, 'items', 'products')).map((i, n) => ({ ...normalizeItem(i, n), subOrderNumber: str(pick(i, 'subOrderNumber')) }));
  const shipping =
    subOrders.reduce((n, s) => n + (num(pick(s, 'shippingCost', 'cost', 'shipping.cost')) ?? 0), 0) || num(pick(o, 'shippingCost', 'shipping.cost'));
  const productTotal = items.reduce((n, i) => n + (i.paidPrice ?? 0), 0);
  return {
    externalId: String(pick(o, 'id', 'orderId', 'originOrderNumber', 'orderNumber')),
    orderNumber: str(pick(o, 'originOrderNumber', 'orderNumber', 'subOrders.0.subOrderNumber', 'id')),
    customerOrderId: str(pick(o, 'subOrders.0.subOrderNumber', 'subOrders.0.items.0.subOrderNumber')),
    orderDate: toDate(pick(o, 'createdAt', 'originOrderDate', 'orderDate', 'created_at')),
    dispatchDeadline: dayOf(pick(o, 'subOrders.0.dispatchDate')),
    carrier: str(pick(o, 'subOrders.0.carrier')),
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
    { key: 'invoicePath', label: 'Ruta de boletas', default: '/v1/invoice', help: 'Donde se suben las boletas y facturas de cada orden' },
    {
      key: 'enviameApiKey',
      label: 'Envíame · API Key (opcional)',
      secret: true,
      help: 'Para agendar retiros e imprimir etiquetas desde Cuadra. En app.enviame.io: Mi empresa / Configuración → API Key (si no aparece, pídela a soporte de Envíame)',
    },
    {
      key: 'enviameSellerId',
      label: 'Envíame · ID de empresa',
      placeholder: '6091',
      help: 'El número que aparece junto a tu empresa en Envíame (ej: 6091 - JERK HOME)',
    },
    { key: 'enviameBaseUrl', label: 'Envíame · URL de la API', default: 'https://api.enviame.io', help: 'Para pruebas: https://stage.api.enviame.io' },
  ],

  uploadInvoice,
  invoicesFor,
  labels,

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
    // 1) Productos (cada variante es un SKU que se vende)
    const found = await pages(
      cfg,
      '/v2/products/search',
      50,
      (p) => str(pick(p, 'id')),
      (n) => progress(`Paris: ${n} productos leídos…`),
    );
    // La búsqueda puede venir sin variantes: entonces se pide el detalle de cada producto
    const full: Record<string, unknown>[] = [];
    for (const [n, p] of found.entries()) {
      const id = str(pick(p, 'id'));
      if (arr(pick(p, 'variants')).length || !id) full.push(p);
      else full.push(await productDetail(cfg, id).catch(() => p));
      if (n % 20 === 19) progress(`Paris: detalle de ${n + 1} de ${found.length} productos…`);
    }
    // 2) Stock de todos los SKU
    progress('Paris: leyendo stock…');
    const stock = new Map<string, number>();
    const stockRows = await pages(
      cfg,
      '/v2/stock',
      100,
      (r) => str(pick(r, 'sku', 'skuSeller')),
      (n) => progress(`Paris: stock de ${n} SKU leído…`),
    ).catch(() => [] as Record<string, unknown>[]);
    for (const r of stockRows) {
      const q = num(pick(r, 'quantity', 'stock', 'available'));
      if (q === null) continue;
      for (const k of [str(pick(r, 'sku')), str(pick(r, 'skuSeller', 'sellerSku'))]) if (k) stock.set(k, q);
    }
    const out: NormalizedProduct[] = [];
    for (const p of full) {
      const variants = arr(pick(p, 'variants'));
      for (const v of variants.length ? variants : [{}]) {
        const sellerSku = str(pick(v, 'skuSeller', 'sellerSku')) ?? str(pick(p, 'sellerSku'));
        if (!sellerSku) continue;
        const sku = str(pick(v, 'sku', 'id'));
        const { list, sale } = pricesOf(arr(pick(v, 'prices')));
        const medias = arr(pick(v, 'medias')).sort((a, b) => (num(pick(a, 'position')) ?? 0) - (num(pick(b, 'position')) ?? 0));
        out.push({
          sellerSku,
          retailerSku: sku,
          name: str(pick(p, 'name')),
          brand: attrValue(p, /^marca$|brand/i),
          price: list,
          salePrice: sale,
          stock: stock.get(sku ?? '') ?? stock.get(sellerSku) ?? num(pick(v, 'stock', 'quantity')),
          status:
            [str(pick(v, 'status', 'status.name')) ?? str(pick(p, 'status', 'status.name')), str(pick(p, 'statusApproval', 'statusApproval.name'))]
              .filter(Boolean)
              .join(' · ') || null,
          url: str(pick(p, 'url', 'channels.0.url')),
          imageUrl: str(pick(medias[0], 'src', 'url')),
          description: attrValue(p, /descrip/i),
          // El id del producto se necesita para modificar nombre y descripción
          raw: { productId: str(pick(p, 'id')), product: { ...p, variants: undefined }, variant: v },
        });
      }
    }
    progress(`Paris: ${out.length} SKU leídos`);
    return out;
  },

  editable: ['stock', 'price', 'salePrice', 'name', 'description'],

  async updateProduct(cfg, target, changes) {
    const done: string[] = [];
    const sku = target.retailerSku ?? target.sellerSku;
    if (changes.stock !== undefined) {
      // Documentado: POST /v2/stock { skus: [{ sku, quantity }] } con el SKU de Paris
      const res = await send(cfg, 'POST', '/v2/stock', { skus: [{ sku, quantity: Math.max(0, Math.round(changes.stock)) }] });
      const failed = rejected(res);
      if (failed) return { status: 'RECHAZADO', message: `Stock: ${failed}` };
      done.push(`stock ${changes.stock}`);
    }
    if (changes.price !== undefined || changes.salePrice !== undefined) {
      await updatePrices(cfg, target, sku, changes);
      done.push(changes.salePrice === null ? 'oferta quitada' : 'precio');
    }
    if (changes.name !== undefined || changes.description !== undefined) {
      await updateContent(cfg, target, changes);
      done.push([changes.name !== undefined && 'nombre', changes.description !== undefined && 'descripción'].filter(Boolean).join(' y '));
    }
    return { status: 'APLICADO', message: `Paris actualizó: ${done.join(', ')}` } satisfies UpdateResult;
  },
};

/**
 * Lee todas las páginas de un listado de Paris. La documentación dice que "offset" es el
 * "número de página", pero no dice si parte en 0 o 1 ni si es en realidad N° de elementos:
 * se detecta comparando la página 0 con la 1.
 */
async function pages(cfg: ProviderConfig, path: string, limit: number, keyOf: (r: Record<string, unknown>) => string | null, progress: (n: number) => void) {
  const sep = path.includes('?') ? '&' : '?';
  const fetchPage = async (offset: number) => findArray(await get(cfg, `${path}${sep}limit=${limit}&offset=${offset}`));
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const add = (rows: Record<string, unknown>[]) => {
    let fresh = 0;
    for (const r of rows) {
      const k = keyOf(r) ?? JSON.stringify(r).slice(0, 200);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
      fresh++;
    }
    return fresh;
  };
  const first = await fetchPage(0);
  add(first);
  progress(out.length);
  if (first.length < limit) return out;
  const second = await fetchPage(1);
  const fresh = add(second);
  progress(out.length);
  // Ninguno nuevo: páginas desde 1 (0 y 1 son la misma) · casi todos repetidos: offset = N° de elementos
  const mode: 'page' | 'items' = fresh > 0 && fresh < Math.min(second.length, limit / 2) ? 'items' : 'page';
  let next = mode === 'items' ? limit : 2;
  if (second.length < limit && mode === 'page' && fresh > 0) return out;
  for (let guard = 0; guard < 2000; guard++) {
    const rows = await fetchPage(next);
    const n = add(rows);
    progress(out.length);
    if (rows.length < limit || n === 0) break;
    next += mode === 'items' ? limit : 1;
  }
  return out;
}

async function productDetail(cfg: ProviderConfig, id: string) {
  const body = await get(cfg, `/v2/products/${encodeURIComponent(id)}`);
  return (pick(body, 'data', 'product') as Record<string, unknown> | null) ?? body;
}

/** Valor de un atributo del producto por nombre (ej: Descripción, Marca) */
function attrValue(p: unknown, name: RegExp): string | null {
  const a = arr(pick(p, 'attributes')).find((x) => name.test(String(pick(x, 'name') ?? '')));
  return a ? str(pick(a, 'value', 'optionName')) : null;
}

/** Precio normal (el mayor) y de oferta (el menor, si hay más de uno y es distinto) */
function pricesOf(prices: Record<string, unknown>[]) {
  const values = prices.map((x) => num(pick(x, 'value'))).filter((x): x is number => x !== null && x > 0);
  if (!values.length) return { list: null, sale: null };
  const list = Math.max(...values);
  const low = Math.min(...values);
  return { list, sale: values.length > 1 && low < list ? low : null };
}

/** Si la respuesta trae errores por SKU, el texto; si no, null */
function rejected(res: Record<string, unknown>): string | null {
  const errors = arr(pick(res, 'errors', 'failed', 'data.errors', 'data.failed'));
  if (!errors.length) return null;
  return errors
    .map((e) => str(pick(e, 'message', 'error', 'detail')) ?? JSON.stringify(e))
    .join(' · ')
    .slice(0, 400);
}

const typeCache = new Map<string, { types: Record<string, unknown>[]; store: string | null; until: number }>();

/** Tipos de precio (normal / oferta) y lista de precios de la tienda, para armar el cambio de precio */
async function priceSetup(cfg: ProviderConfig) {
  const key = cfg.secrets.apiKey ?? '';
  const hit = typeCache.get(key);
  if (hit && hit.until > Date.now()) return hit;
  const types = findArray(await get(cfg, '/v2/price-types'));
  const stores = findArray(await get(cfg, '/v2/store-prices'));
  const store = str(pick(stores.find((x) => /paris|default|general|principal/i.test(String(pick(x, 'name') ?? ''))) ?? stores[0], 'id'));
  const value = { types, store, until: Date.now() + 3600000 };
  typeCache.set(key, value);
  return value;
}

const isSaleType = (name: string) => /oferta|offer|sale|promo|internet|descuento/i.test(name);

/**
 * POST /v2/prices/product/{sku} { prices: [...] }.
 * Para quitar una oferta se manda solo el precio normal. La oferta necesita fechas.
 */
async function updatePrices(cfg: ProviderConfig, target: UpdateTarget, sku: string, changes: ProductChanges) {
  const { types, store } = await priceSetup(cfg);
  const current = arr(pick(target.raw, 'variant.prices'));
  // El tipo "normal" es el del precio más alto que ya tiene el producto; si no, el que no es oferta
  const top = current.reduce<Record<string, unknown> | null>((a, b) => ((num(pick(b, 'value')) ?? 0) > (num(pick(a, 'value')) ?? -1) ? b : a), null);
  const listType =
    str(pick(top, 'type.id')) ??
    str(
      pick(
        types.find((t) => !isSaleType(String(pick(t, 'name') ?? ''))),
        'id',
      ),
    );
  const saleType = str(
    pick(
      types.find((t) => isSaleType(String(pick(t, 'name') ?? '')) && str(pick(t, 'id')) !== listType),
      'id',
    ),
  );
  if (!listType) throw new ProviderError('Paris no informó los tipos de precio (/v2/price-types)');
  const price = changes.price ?? target.price;
  if (!price) throw new ProviderError('Falta el precio normal');
  const prices: Record<string, unknown>[] = [{ value: Math.round(price), type: listType, ...(store ? { storePrice: store } : {}) }];
  const sale = changes.salePrice === undefined ? target.salePrice : changes.salePrice;
  if (sale) {
    if (!saleType) throw new ProviderError('Paris no tiene un tipo de precio de oferta en /v2/price-types');
    if (!changes.saleFrom || !changes.saleTo) throw new ProviderError('La oferta necesita fecha de inicio y de término');
    prices.push({
      value: Math.round(sale),
      type: saleType,
      ...(store ? { storePrice: store } : {}),
      showFrom: `${changes.saleFrom}T00:00:00`,
      showTo: `${changes.saleTo}T23:59:59`,
    });
  }
  const res = await send(cfg, 'POST', `/v2/prices/product/${encodeURIComponent(sku)}`, { prices });
  const failed = rejected(res);
  if (failed) throw new ProviderError(`Precio: ${failed}`);
}

/**
 * Nombre y descripción: PATCH /v2/products/{id} con TODA la información del producto
 * (si falta algo, Paris lo borra). Se lee el producto actual y se cambia solo lo pedido.
 */
async function updateContent(cfg: ProviderConfig, target: UpdateTarget, changes: ProductChanges) {
  const id = str(pick(target.raw, 'productId'));
  if (!id) throw new ProviderError('No se conoce el id del producto en Paris: vuelve a traer los productos');
  const p = await productDetail(cfg, id);
  // Los atributos de lista (ej: Marca) se envían con el id de la opción; los de texto, con su valor
  const attrs = arr(pick(p, 'attributes')).map((a) => ({ id: pick(a, 'id'), value: pick(a, 'optionId', 'value'), name: str(pick(a, 'name')) ?? '' }));
  if (changes.description !== undefined) {
    const d = attrs.find((a) => /descrip/i.test(a.name));
    if (!d) throw new ProviderError('Este producto de Paris no tiene un atributo de descripción');
    d.value = changes.description;
  }
  const body = {
    product: {
      name: changes.name ?? str(pick(p, 'name')),
      sellerSku: str(pick(p, 'sellerSku')),
      familyId: pick(p, 'family.id', 'familyId'),
      category: pick(p, 'category.id', 'category'),
      attributes: attrs.map(({ id: aid, value }) => ({ id: aid, value })),
    },
    variants: arr(pick(p, 'variants')).map((v) => ({
      skuSeller: str(pick(v, 'skuSeller', 'sellerSku')),
      status: str(pick(v, 'status', 'status.name')) ?? 'Enabled',
      attributes: arr(pick(v, 'attributes')).map((a) => ({ id: pick(a, 'id'), value: pick(a, 'optionId', 'value') })),
      medias: arr(pick(v, 'medias')).map((m, n) => ({
        position: num(pick(m, 'position')) ?? n + 1,
        src: str(pick(m, 'src', 'url')),
        name: str(pick(m, 'name')) ?? (str(pick(m, 'src')) ?? '').split('/').pop()?.split('?')[0] ?? `imagen-${n + 1}`,
      })),
    })),
  };
  await send(cfg, 'PATCH', `/v2/products/${encodeURIComponent(id)}`, body);
}
