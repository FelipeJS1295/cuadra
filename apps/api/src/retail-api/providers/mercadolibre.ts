import { arr, dayOf, findDeep, http, num, pick, str, toDate } from './util.js';
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
 * Mercado Libre Chile (ventas y publicaciones) + Mercado Pago (lo que te liquidan por cada venta).
 * Documentación: https://developers.mercadolibre.cl
 *
 * Autorización OAuth: la empresa crea una aplicación en developers.mercadolibre.cl (App ID, Secret y
 * URL de redirección), autoriza a Cuadra y pega el "code" que queda en la dirección. Cuadra lo cambia por
 * un refresh token y lo renueva solo (cada renovación entrega uno nuevo, que se guarda).
 *
 *   POST /oauth/token                               tokens
 *   GET  /users/me                                  id del vendedor
 *   GET  /orders/search?seller=&order.date_created.from=&to=&offset&limit=50
 *   GET  /shipments/{id}                            estado del envío y fecha de entrega
 *   GET  /orders/{id}/billing_info                  RUT y nombre para la boleta
 *   GET  /users/{id}/items/search  ·  GET /items?ids=…   publicaciones
 *   PUT  /items/{id}  ·  PUT /items/{id}/description     stock, precio, título, descripción
 *   Mercado Pago: GET /v1/payments/{id}             comisión, envío, retenciones, neto y fecha de liberación
 */

const API = (cfg: ProviderConfig) => (cfg.settings.apiUrl || 'https://api.mercadolibre.com').replace(/\/+$/, '');
const MP = (cfg: ProviderConfig) => (cfg.settings.mpUrl || 'https://api.mercadopago.com').replace(/\/+$/, '');

const tokens = new Map<string, { token: string; userId: string; until: number }>();

const dayCL = (v: unknown) => {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d) : null;
};

async function oauth(cfg: ProviderConfig, body: Record<string, string>) {
  const { json } = await http(`${API(cfg)}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const access = str(pick(json, 'access_token'));
  const refresh = str(pick(json, 'refresh_token'));
  if (!access) throw new ProviderError('Mercado Libre no entregó el token de acceso');
  return { access, refresh, ttl: (num(pick(json, 'expires_in')) ?? 21600) * 1000, userId: str(pick(json, 'user_id')) };
}

/** Token vigente (lo renueva con el refresh token, o con el "code" la primera vez) */
async function token(cfg: ProviderConfig): Promise<{ token: string; userId: string }> {
  const clientId = cfg.settings.clientId?.trim();
  const secret = cfg.secrets.clientSecret?.trim();
  if (!clientId || !secret) throw new ProviderError('Faltan el App ID y el Secret de tu aplicación de Mercado Libre');
  const cached = tokens.get(clientId);
  if (cached && cached.until > Date.now()) return cached;

  let t: Awaited<ReturnType<typeof oauth>>;
  const code = cfg.secrets.code?.trim();
  if (code) {
    t = await oauth(cfg, { grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code, redirect_uri: cfg.settings.redirectUri ?? '' });
    // El code sirve una sola vez
    await cfg.saveSecret?.('code', '');
  } else if (cfg.secrets.refreshToken) {
    t = await oauth(cfg, { grant_type: 'refresh_token', client_id: clientId, client_secret: secret, refresh_token: cfg.secrets.refreshToken });
  } else {
    throw new ProviderError('Falta autorizar a Cuadra en Mercado Libre: abre el enlace de autorización y pega el código que aparece en la dirección');
  }
  if (t.refresh) {
    cfg.secrets.refreshToken = t.refresh;
    await cfg.saveSecret?.('refreshToken', t.refresh);
  }
  let userId = t.userId;
  if (!userId) {
    const { json } = await http(`${API(cfg)}/users/me`, { headers: { Authorization: `Bearer ${t.access}` } });
    userId = String(pick(json, 'id'));
  }
  const value = { token: t.access, userId, until: Date.now() + Math.min(t.ttl, 6 * 3600000) - 120000 };
  tokens.set(clientId, value);
  return value;
}

async function get(cfg: ProviderConfig, path: string) {
  const t = await token(cfg);
  const { json } = await http(`${API(cfg)}${path}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' }, timeoutMs: 60000 });
  return (json ?? {}) as Record<string, unknown>;
}

async function send(cfg: ProviderConfig, method: string, path: string, body: unknown) {
  const t = await token(cfg);
  const { json } = await http(`${API(cfg)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 60000,
  });
  return (json ?? {}) as Record<string, unknown>;
}

/** Mercado Pago: con su Access Token propio si la empresa lo dejó; si no, con el de Mercado Libre */
async function mpGet(cfg: ProviderConfig, path: string) {
  const mpToken = cfg.secrets.mpAccessToken?.trim() || (await token(cfg)).token;
  const { json } = await http(`${MP(cfg)}${path}`, { headers: { Authorization: `Bearer ${mpToken}`, Accept: 'application/json' }, timeoutMs: 60000 });
  return (json ?? {}) as Record<string, unknown>;
}

/** "2026-10-01" -> "2026-10-01T00:00:00.000-03:00" */
const isoStart = (d: string) => `${d}T00:00:00.000-03:00`;
const isoEnd = (d: string) => `${d}T23:59:59.999-03:00`;

async function normalizeOrder(cfg: ProviderConfig, o: Record<string, unknown>): Promise<NormalizedOrder> {
  const id = String(pick(o, 'id'));
  const payments = arr(pick(o, 'payments'));
  // Lo que el cliente pagó por el envío
  const buyerShipping = payments.reduce((n, p) => n + (String(pick(p, 'status')) === 'approved' ? (num(pick(p, 'shipping_cost')) ?? 0) : 0), 0);

  // Envío: estado y entrega (la orden queda "paid" aunque ya se entregó)
  let shipStatus: string | null = null;
  let deliveredAt: Date | null = null;
  let address: string | null = null;
  let commune: string | null = null;
  let region: string | null = null;
  let handlingLimit: string | null = null;
  const shipId = str(pick(o, 'shipping.id'));
  if (shipId) {
    const s = await get(cfg, `/shipments/${shipId}`).catch(() => null);
    if (s) {
      shipStatus = str(pick(s, 'status'));
      deliveredAt = toDate(pick(s, 'status_history.date_delivered'));
      address = [str(pick(s, 'receiver_address.street_name')), str(pick(s, 'receiver_address.street_number'))].filter(Boolean).join(' ') || null;
      commune = str(pick(s, 'receiver_address.city.name', 'receiver_address.neighborhood.name'));
      region = str(pick(s, 'receiver_address.state.name'));
      // Hasta cuándo hay que despachar
      handlingLimit = dayOf(pick(s, 'shipping_option.estimated_handling_limit.date', 'lead_time.estimated_handling_limit.date'));
    }
  }
  // RUT y nombre para la boleta / factura
  const bill = await get(cfg, `/orders/${id}/billing_info`).catch(() => null);
  const info = arr(pick(bill, 'billing_info.additional_info'));
  const extra = (type: string) => str(pick(info.find((x) => String(pick(x, 'type')) === type) ?? {}, 'value'));
  const buyerName =
    [extra('FIRST_NAME'), extra('LAST_NAME')].filter(Boolean).join(' ') ||
    extra('BUSINESS_NAME') ||
    [str(pick(o, 'buyer.first_name')), str(pick(o, 'buyer.last_name'))].filter(Boolean).join(' ') ||
    str(pick(o, 'buyer.nickname'));
  const rut = str(pick(bill, 'billing_info.doc_number')) ?? findDeep(bill, /^(doc_number|identification_number)$/i);

  const orderItems = arr(pick(o, 'order_items'));
  const items: NormalizedItem[] = orderItems.map((i, n) => {
    const qty = num(pick(i, 'quantity')) ?? 1;
    const unit = num(pick(i, 'unit_price')) ?? 0;
    return {
      externalItemId: `${id}|${str(pick(i, 'item.id')) ?? n + 1}${pick(i, 'item.variation_id') ? `|${pick(i, 'item.variation_id')}` : ''}`,
      sellerSku: str(pick(i, 'item.seller_sku', 'item.seller_custom_field')) ?? str(pick(i, 'item.id')),
      retailerSku: str(pick(i, 'item.id')),
      name: str(pick(i, 'item.title')),
      quantity: qty,
      unitPrice: unit,
      paidPrice: unit * qty,
      // El envío pagado por el cliente va en la primera línea
      shippingAmount: n === 0 && buyerShipping ? buyerShipping : null,
      status: shipStatus ?? str(pick(o, 'status')),
      deliveredAt,
      raw: i,
    };
  });
  const status = String(pick(o, 'status') ?? '');
  return {
    externalId: id,
    orderNumber: id,
    customerOrderId: str(pick(o, 'pack_id')),
    orderDate: toDate(pick(o, 'date_created')),
    dispatchDeadline: handlingLimit,
    // Cancelada manda; si no, el estado del envío (entregado, en camino…)
    status: /cancel/i.test(status) ? status : (shipStatus ?? status),
    customerName: buyerName || null,
    customerRut: rut,
    customerEmail: null,
    address,
    commune,
    region,
    total: (num(pick(o, 'total_amount')) ?? 0) + buyerShipping,
    shippingTotal: buyerShipping || null,
    items,
    raw: o,
  };
}

/** Variante o publicación -> producto de Cuadra */
function productOf(item: Record<string, unknown>, v: Record<string, unknown> | null): NormalizedProduct | null {
  const attrSku = (src: unknown) => str(pick(arr(pick(src, 'attributes')).find((a) => String(pick(a, 'id')) === 'SELLER_SKU') ?? {}, 'value_name'));
  const sku = (v ? (str(pick(v, 'seller_custom_field')) ?? attrSku(v)) : null) ?? str(pick(item, 'seller_custom_field')) ?? attrSku(item) ?? `${pick(item, 'id')}${v ? `-${pick(v, 'id')}` : ''}`;
  const original = num(pick(item, 'original_price'));
  const price = num(pick(v ?? item, 'price')) ?? num(pick(item, 'price'));
  return {
    sellerSku: sku,
    retailerSku: str(pick(item, 'id')),
    name: str(pick(item, 'title')),
    brand: str(pick(arr(pick(item, 'attributes')).find((a) => String(pick(a, 'id')) === 'BRAND') ?? {}, 'value_name')),
    // Con oferta, Mercado Libre informa el precio anterior en original_price
    price: original ?? price,
    salePrice: original && price && price < original ? price : null,
    stock: num(pick(v ?? item, 'available_quantity')),
    status: str(pick(item, 'status')),
    url: str(pick(item, 'permalink')),
    imageUrl: str(pick(item, 'secure_thumbnail', 'thumbnail')),
    raw: { itemId: str(pick(item, 'id')), variationId: v ? str(pick(v, 'id')) : null, item: { ...item, variations: undefined }, variation: v },
  };
}

export const mercadolibre: RetailProvider = {
  code: 'MERCADOLIBRE',
  label: 'Mercado Libre',
  howTo:
    '1) En developers.mercadolibre.cl crea una aplicación (Mis aplicaciones → Crear) con permisos de órdenes, publicaciones y pagos; copia su App ID y Secret, y la URL de redirección que pusiste. 2) Guarda y abre "Autorizar en Mercado Libre". 3) Al volver, copia el valor de "code=" de la dirección y pégalo en "Código de autorización". Opcional: el Access Token de producción de Mercado Pago (Tu negocio → Credenciales) para leer el detalle de cada pago.',
  docsUrl: 'https://developers.mercadolibre.cl/es_ar/api-docs-es',
  fields: [
    { key: 'clientId', label: 'App ID', required: true },
    { key: 'clientSecret', label: 'Secret de la aplicación', secret: true, required: true },
    { key: 'redirectUri', label: 'URL de redirección', placeholder: 'https://…', help: 'La misma que registraste en tu aplicación' },
    { key: 'code', label: 'Código de autorización', secret: true, help: 'El valor de "code=" que aparece en la dirección después de autorizar' },
    { key: 'mpAccessToken', label: 'Access Token de Mercado Pago (opcional)', secret: true, help: 'Producción, empieza con APP_USR-' },
    { key: 'apiUrl', label: 'URL API Mercado Libre', default: 'https://api.mercadolibre.com' },
    { key: 'mpUrl', label: 'URL API Mercado Pago', default: 'https://api.mercadopago.com' },
  ],

  async test(cfg) {
    const t = await token(cfg);
    const me = await get(cfg, '/users/me');
    return { message: `Conexión OK: vendedor ${str(pick(me, 'nickname')) ?? t.userId}`, sample: { id: pick(me, 'id'), nickname: pick(me, 'nickname'), site: pick(me, 'site_id') } };
  },

  async orders(cfg, from, to, progress) {
    const { userId } = await token(cfg);
    const raw: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 10000; offset += 50) {
      const q = new URLSearchParams({
        seller: userId,
        'order.date_created.from': isoStart(from),
        'order.date_created.to': isoEnd(to),
        sort: 'date_asc',
        offset: String(offset),
        limit: '50',
      });
      const body = await get(cfg, `/orders/search?${q}`);
      const page = arr(pick(body, 'results'));
      raw.push(...page);
      const total = num(pick(body, 'paging.total'));
      progress(`Mercado Libre: ${raw.length}${total !== null ? ` de ${total}` : ''} órdenes leídas…`);
      if (page.length < 50 || (total !== null && raw.length >= total)) break;
    }
    const out: NormalizedOrder[] = [];
    for (const [n, o] of raw.entries()) {
      out.push(await normalizeOrder(cfg, o));
      if (n % 5 === 4) progress(`Mercado Libre: envío y facturación de ${n + 1} de ${raw.length} órdenes…`);
    }
    return out;
  },

  /**
   * Mercado Pago: por cada pago de las órdenes, lo cobrado al cliente, la comisión, el envío,
   * las retenciones y el neto que liberó (o liberará) en tu cuenta.
   */
  async settlements(cfg, _from, _to, progress, orders) {
    const out: NormalizedSettlement[] = [];
    const list = orders.flatMap((o) =>
      arr(pick(o.raw, 'payments'))
        .filter((p) => ['approved', 'refunded', 'charged_back'].includes(String(pick(p, 'status'))))
        .map((p) => ({ order: o, paymentId: str(pick(p, 'id')) })),
    );
    for (const [n, { order, paymentId }] of list.entries()) {
      if (!paymentId) continue;
      const p = await mpGet(cfg, `/v1/payments/${paymentId}`).catch(() => null);
      if (!p) continue;
      const date = dayCL(pick(p, 'money_release_date', 'date_approved'));
      const status = str(pick(p, 'money_release_status')) ?? str(pick(p, 'status'));
      const refunded = String(pick(p, 'status')) === 'refunded';
      const sign = refunded ? 0 : 1;
      const firstItem = order.items[0];
      const line = (key: string, kind: NormalizedSettlement['kind'], type: string, amount: number, pct?: number | null) => {
        if (!amount) return;
        out.push({
          lineKey: `MP|${paymentId}|${key}`,
          orderNumber: order.orderNumber,
          // Se cruza por orden: la conciliación usa este campo como llave
          saleItemId: order.orderNumber,
          sellerSku: firstItem?.sellerSku ?? null,
          productName: firstItem?.name ?? null,
          kind,
          transactionType: type,
          transactionDate: date,
          amountGross: Math.round(amount),
          commissionPct: pct ?? null,
          paymentStatus: status,
          statementNumber: paymentId,
          raw: { id: pick(p, 'id'), status: pick(p, 'status'), money_release_date: pick(p, 'money_release_date'), transaction_details: pick(p, 'transaction_details'), fee_details: pick(p, 'fee_details') },
        });
      };
      const product = (num(pick(p, 'transaction_amount')) ?? 0) * sign;
      const shipping = (num(pick(p, 'shipping_amount', 'shipping_cost')) ?? 0) * sign;
      line('producto', 'PRODUCT_PAYMENT', 'Venta', product);
      line('envio', 'SHIPPING', 'Envío pagado por el cliente', shipping);
      let accounted = product + shipping;
      for (const [i, f] of arr(pick(p, 'fee_details')).entries()) {
        const type = String(pick(f, 'type') ?? 'cargo');
        const amount = -(num(pick(f, 'amount')) ?? 0) * sign;
        const isShipping = /ship|envio/i.test(type);
        line(`fee${i}`, isShipping ? 'SHIPPING' : 'COMMISSION', isShipping ? 'Envío' : `Comisión (${type})`, amount, isShipping || !product ? null : Math.round((-amount / product) * 1000) / 10);
        accounted += amount;
      }
      // Retenciones y otros descuentos: lo que falta para llegar al neto que liberó Mercado Pago
      const net = num(pick(p, 'transaction_details.net_received_amount'));
      if (net !== null && !refunded) {
        const rest = Math.round(net - accounted);
        if (Math.abs(rest) >= 1) line('otros', 'OTHER', 'Retenciones y otros cargos', rest);
      }
      if (n % 10 === 9) progress(`Mercado Pago: ${n + 1} de ${list.length} pagos revisados…`);
    }
    return out;
  },

  async products(cfg, progress) {
    const { userId } = await token(cfg);
    const ids: string[] = [];
    let scroll: string | null = null;
    for (let page = 0; page < 400; page++) {
      // "scan" permite recorrer más de 1.000 publicaciones
      const q = new URLSearchParams({ search_type: 'scan', limit: '100', ...(scroll ? { scroll_id: scroll } : {}) });
      const body = await get(cfg, `/users/${userId}/items/search?${q}`);
      const got = arr<string>(pick(body, 'results')).map(String);
      ids.push(...got);
      scroll = str(pick(body, 'scroll_id'));
      progress(`Mercado Libre: ${ids.length} publicaciones encontradas…`);
      if (!got.length || !scroll) break;
    }
    const out: NormalizedProduct[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const body = (await get(cfg, `/items?ids=${ids.slice(i, i + 20).join(',')}`)) as unknown;
      for (const r of arr(body)) {
        const item = (pick(r, 'body') ?? r) as Record<string, unknown>;
        const variations = arr(pick(item, 'variations'));
        for (const v of variations.length ? variations : [null]) {
          const p = productOf(item, v);
          if (p) out.push(p);
        }
      }
      progress(`Mercado Libre: ${out.length} productos leídos…`);
    }
    return out;
  },

  // Las ofertas de Mercado Libre se arman con campañas en su portal
  editable: ['stock', 'price', 'name', 'description'],

  async updateProduct(cfg, target, changes) {
    const raw = (target.raw ?? {}) as { itemId?: string; variationId?: string | null };
    const itemId = raw.itemId ?? target.retailerSku;
    if (!itemId) throw new ProviderError('No se conoce la publicación: vuelve a traer los productos');
    const done: string[] = [];
    if (changes.stock !== undefined || changes.price !== undefined || changes.name !== undefined) {
      const body: Record<string, unknown> = {};
      if (changes.name !== undefined) body.title = changes.name;
      if (raw.variationId) {
        body.variations = [
          {
            id: Number(raw.variationId),
            ...(changes.stock !== undefined ? { available_quantity: changes.stock } : {}),
            ...(changes.price !== undefined ? { price: changes.price } : {}),
          },
        ];
      } else {
        if (changes.stock !== undefined) body.available_quantity = changes.stock;
        if (changes.price !== undefined) body.price = changes.price;
      }
      await send(cfg, 'PUT', `/items/${itemId}`, body);
      if (changes.stock !== undefined) done.push(`stock ${changes.stock}`);
      if (changes.price !== undefined) done.push('precio');
      if (changes.name !== undefined) done.push('título');
    }
    if (changes.description !== undefined) {
      await send(cfg, 'PUT', `/items/${itemId}/description`, { plain_text: changes.description });
      done.push('descripción');
    }
    return { status: 'APLICADO', message: `Mercado Libre actualizó: ${done.join(', ')}` };
  },
};
