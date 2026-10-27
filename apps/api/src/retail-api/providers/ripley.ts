import { arr, dayOf, findDeep, http, num, pick, str, toDate } from './util.js';
import {
  ProviderError,
  type InvoiceUpload,
  type NormalizedItem,
  type NormalizedOrder,
  type NormalizedProduct,
  type NormalizedSettlement,
  type ProviderConfig,
  type RetailProvider,
  type UpdateResult,
} from './types.js';

/**
 * Ripley (Mercado Ripley) funciona sobre Mirakl. Documentación: https://developer.mirakl.com
 * Autenticación: la "Clave de API" del portal (https://ripley-prod.mirakl.net → tu usuario → Clave de API)
 * va tal cual en el header Authorization.
 *
 *   OR11  GET  /api/orders                              órdenes (max 100, offset)
 *   OF21  GET  /api/offers                              ofertas: precio, stock, oferta
 *   OF24  POST /api/offers                              actualizar precio / stock / oferta (asíncrono)
 *   OF02  GET  /api/offers/imports/{import_id}          resultado de esa actualización
 *   TL02  GET  /api/sellerpayment/transactions_logs     movimientos de la liquidación (venta, comisión, envío…)
 *   OR72  GET  /api/orders/documents                    documentos ya subidos a una orden
 *   OR74  POST /api/orders/{order_id}/documents         subir la boleta (multipart: files + order_documents)
 */

const base = (cfg: ProviderConfig) => (cfg.settings.baseUrl || 'https://ripley-prod.mirakl.net').replace(/\/+$/, '');

function headers(cfg: ProviderConfig, json = false): Record<string, string> {
  const key = cfg.secrets.apiKey?.trim();
  if (!key) throw new ProviderError('Falta la Clave de API de Ripley');
  return { Authorization: key, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function get(cfg: ProviderConfig, path: string) {
  const { json } = await http(`${base(cfg)}${path}`, { headers: headers(cfg), timeoutMs: 90000 });
  return (json ?? {}) as Record<string, unknown>;
}

/**
 * Sube la boleta a la orden (OR74). Ripley pide la boleta en PDF con texto seleccionable en los
 * documentos de cada pedido; el cliente la ve desde ahí.
 */
async function uploadInvoice(cfg: ProviderConfig, input: InvoiceUpload) {
  const orderId = input.externalOrderId ?? input.orderNumber;
  const fileName = `${input.type}-${input.number}.pdf`;
  // ¿Ya está? (OR72)
  const existing = await get(cfg, `/api/orders/documents?order_ids=${encodeURIComponent(orderId)}`).catch(() => null);
  const docs = arr<Record<string, unknown>>(pick(existing, 'order_documents'));
  const found = docs.find((d) => String(pick(d, 'file_name') ?? '').toLowerCase() === fileName.toLowerCase());
  if (found) return { id: str(pick(found, 'id')), already: true, raw: found };

  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), fileName);
  form.append('order_documents', JSON.stringify({ order_documents: [{ file_name: fileName, type_code: cfg.settings.invoiceTypeCode || 'CUSTOMER_INVOICE' }] }));
  const { json } = await http(`${base(cfg)}/api/orders/${encodeURIComponent(orderId)}/documents`, {
    method: 'POST',
    // Sin Content-Type: fetch arma el multipart con su "boundary"
    headers: headers(cfg),
    body: form,
    timeoutMs: 90000,
  });
  if ((num(pick(json, 'errors_count')) ?? 0) > 0) {
    const msg = str(findDeep(json, /^message$/i)) ?? JSON.stringify(pick(json, 'order_documents', 'document_errors')).slice(0, 300);
    throw new ProviderError(`Ripley no aceptó la boleta: ${msg}`);
  }
  return { id: str(pick(json, 'order_documents.0.id', 'document_details.0.id')), already: false, raw: json };
}

/** Boletas en los documentos de cada pedido (OR72, de a 100 pedidos) */
async function invoicesFor(cfg: ProviderConfig, orders: { orderNumber: string; externalOrderId: string | null }[], progress: (m: string) => void) {
  const type = (cfg.settings.invoiceTypeCode || 'CUSTOMER_INVOICE').toUpperCase();
  const out = new Map<string, string[]>();
  const idOf = (o: { orderNumber: string; externalOrderId: string | null }) => o.externalOrderId ?? o.orderNumber;
  for (let i = 0; i < orders.length; i += 100) {
    const chunk = orders.slice(i, i + 100);
    const body = await get(cfg, `/api/orders/documents?order_ids=${chunk.map((o) => encodeURIComponent(idOf(o))).join(',')}`);
    const docs = arr<Record<string, unknown>>(pick(body, 'order_documents'));
    for (const o of chunk) {
      const mine = docs.filter((d) => String(pick(d, 'order_id') ?? '') === idOf(o) && String(pick(d, 'type', 'type_code') ?? type).toUpperCase() === type);
      out.set(o.orderNumber, mine.map((d) => String(pick(d, 'file_name') ?? 'documento')));
    }
    progress(`Revisando boletas en Ripley: ${Math.min(i + 100, orders.length)} de ${orders.length}…`);
  }
  return out;
}

/** "2026-10-01" -> "2026-10-01T00:00:00-03:00" (Mirakl recibe fechas ISO) */
const isoStart = (d: string) => `${d}T00:00:00-03:00`;
const isoEnd = (d: string) => `${d}T23:59:59-03:00`;
const day = (v: unknown) => {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d) : null;
};

function normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
  const lines = arr(pick(o, 'order_lines'));
  const items: NormalizedItem[] = lines.map((l, n) => {
    const qty = num(pick(l, 'quantity')) ?? 1;
    const price = num(pick(l, 'price')) ?? (num(pick(l, 'price_unit')) ?? 0) * qty;
    return {
      externalItemId: String(pick(l, 'order_line_id') ?? `${pick(o, 'order_id')}-${n + 1}`),
      sellerSku: str(pick(l, 'offer_sku', 'shop_sku')),
      retailerSku: str(pick(l, 'product_sku')),
      name: str(pick(l, 'product_title')),
      quantity: qty,
      unitPrice: num(pick(l, 'price_unit')) ?? (qty ? price / qty : price),
      paidPrice: price,
      // Lo que pagó el cliente por el envío de esta línea
      shippingAmount: num(pick(l, 'shipping_price')),
      status: str(pick(l, 'order_line_state')),
      deliveredAt: toDate(pick(l, 'received_date')),
      raw: l,
    };
  });
  const bill = (pick(o, 'customer.billing_address') ?? {}) as Record<string, unknown>;
  const ship = (pick(o, 'customer.shipping_address') ?? {}) as Record<string, unknown>;
  const name = [str(pick(o, 'customer.firstname')), str(pick(o, 'customer.lastname'))].filter(Boolean).join(' ');
  return {
    externalId: String(pick(o, 'order_id')),
    orderNumber: str(pick(o, 'order_id')),
    customerOrderId: str(pick(o, 'commercial_id')),
    orderDate: toDate(pick(o, 'created_date')),
    dispatchDeadline: dayOf(pick(o, 'shipping_deadline')),
    status: str(pick(o, 'order_state')),
    customerName: name || [str(pick(bill, 'firstname')), str(pick(bill, 'lastname'))].filter(Boolean).join(' ') || null,
    // En Ripley el RUT suele venir en los campos adicionales de la orden
    customerRut: rutFromFields(o) ?? findDeep(o, /^(rut|customer_rut|document_number|documento)$/i),
    customerEmail: str(pick(o, 'customer_notification_email')),
    address: [str(pick(ship, 'street_1')), str(pick(ship, 'street_2'))].filter(Boolean).join(' ') || null,
    commune: str(pick(ship, 'city')),
    region: str(pick(ship, 'state')),
    total: num(pick(o, 'total_price')),
    shippingTotal: num(pick(o, 'shipping_price')),
    items,
    raw: o,
  };
}

/** RUT en "order_additional_fields" (Ripley lo pide al cliente para la boleta) */
function rutFromFields(o: Record<string, unknown>): string | null {
  const fields = arr(pick(o, 'order_additional_fields'));
  const f = fields.find((x) => /rut|document|identifica/i.test(String(pick(x, 'code') ?? '')));
  return f ? str(pick(f, 'value')) : null;
}

/** Tipo de movimiento de Mirakl -> tipo de Cuadra */
function kindOf(type: string): NormalizedSettlement['kind'] | null {
  if (type === 'PAYMENT' || type.startsWith('RESERVE')) return null; // el depósito mismo, no un concepto
  if (/SHIPPING/.test(type)) return 'SHIPPING';
  if (/COMMISSION/.test(type)) return 'COMMISSION';
  if (/ORDER_AMOUNT/.test(type)) return 'PRODUCT_PAYMENT';
  if (/PENALTY/.test(type)) return 'PENALTY';
  return 'OTHER';
}

export const ripley: RetailProvider = {
  code: 'RIPLEY',
  label: 'Ripley',
  howTo:
    'Entra a https://ripley-prod.mirakl.net con tu usuario de Mercado Ripley, toca tu usuario arriba a la derecha y copia la "Clave de API". Con ella Cuadra trae tus órdenes, la liquidación y tus ofertas.',
  docsUrl: 'https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3',
  fields: [
    { key: 'apiKey', label: 'Clave de API', secret: true, required: true },
    { key: 'baseUrl', label: 'URL de la API', default: 'https://ripley-prod.mirakl.net' },
    {
      key: 'invoiceTypeCode',
      label: 'Tipo de documento de la boleta',
      default: 'CUSTOMER_INVOICE',
      help: 'Código con que Ripley guarda la boleta en los documentos del pedido (Mirakl). Cámbialo solo si Ripley te indica otro',
    },
  ],

  uploadInvoice,
  invoicesFor,

  async test(cfg) {
    const body = await get(cfg, '/api/account');
    const name = str(pick(body, 'shop_name', 'name'));
    return { message: `Conexión OK${name ? `: tienda ${name}` : ''}`, sample: body };
  },

  async orders(cfg, from, to, progress) {
    const out: NormalizedOrder[] = [];
    for (let offset = 0; offset < 20000; offset += 100) {
      const body = await get(cfg, `/api/orders?start_date=${encodeURIComponent(isoStart(from))}&end_date=${encodeURIComponent(isoEnd(to))}&max=100&offset=${offset}`);
      const page = arr(pick(body, 'orders'));
      out.push(...page.map(normalizeOrder));
      const total = num(pick(body, 'total_count'));
      progress(`Ripley: ${out.length}${total !== null ? ` de ${total}` : ''} órdenes leídas…`);
      if (page.length < 100 || (total !== null && out.length >= total)) break;
    }
    return out;
  },

  /** Movimientos de la liquidación (TL02) de las órdenes del período */
  async settlements(cfg, from, _to, progress) {
    const out: NormalizedSettlement[] = [];
    let token: string | null = null;
    for (let page = 0; page < 500; page++) {
      const q = new URLSearchParams({ date_created_from: isoStart(from), limit: '500', ...(token ? { page_token: token } : {}) });
      const body = await get(cfg, `/api/sellerpayment/transactions_logs?${q}`);
      for (const t of arr(pick(body, 'data'))) {
        const type = String(pick(t, 'type') ?? '');
        const kind = kindOf(type);
        if (!kind) continue;
        const credited = num(pick(t, 'amount_credited')) ?? 0;
        const debited = num(pick(t, 'amount_debited')) ?? 0;
        const amount = num(pick(t, 'amount')) ?? credited - debited;
        if (!amount) continue;
        out.push({
          lineKey: `TL|${pick(t, 'id')}`,
          orderNumber: str(pick(t, 'entities.order.id', 'order_id')),
          saleItemId: str(pick(t, 'entities.order_line.id', 'order_line_id')),
          kind,
          transactionType: type,
          transactionDate: day(pick(t, 'entities.transaction_info.date', 'date_created')),
          amountGross: amount,
          paymentStatus: str(pick(t, 'payment_state')),
          statementNumber: str(pick(t, 'accounting_document_number')),
          raw: t,
        });
      }
      progress(`Ripley: ${out.length} movimientos de la liquidación…`);
      token = str(pick(body, 'next_page_token'));
      if (!token) break;
    }
    return out;
  },

  async products(cfg, progress) {
    const out: NormalizedProduct[] = [];
    for (let offset = 0; offset < 50000; offset += 100) {
      const body = await get(cfg, `/api/offers?max=100&offset=${offset}`);
      const page = arr(pick(body, 'offers'));
      for (const o of page) {
        const sku = str(pick(o, 'shop_sku'));
        if (!sku) continue;
        const discount = num(pick(o, 'discount.discount_price', 'applicable_pricing.discount_price'));
        out.push({
          sellerSku: sku,
          retailerSku: str(pick(o, 'product_sku')),
          name: str(pick(o, 'product_title')),
          brand: str(pick(o, 'product_brand')),
          price: num(pick(o, 'price', 'applicable_pricing.price')),
          salePrice: discount,
          stock: num(pick(o, 'quantity')),
          status: pick(o, 'active') === false ? 'Inactiva' : str(pick(o, 'state_code')) === '11' ? 'Activa' : str(pick(o, 'state_code')),
          url: null,
          imageUrl: str(pick(o, 'product_medias.0.media_url')),
          description: str(pick(o, 'description')),
          raw: o,
        });
      }
      const total = num(pick(body, 'total_count'));
      progress(`Ripley: ${out.length} ofertas leídas…`);
      if (page.length < 100 || (total !== null && out.length >= total)) break;
    }
    return out;
  },

  // Mirakl deja cambiar por API el precio, el stock y la oferta. El contenido de la ficha lo administra Ripley
  editable: ['stock', 'price', 'salePrice'],

  async updateProduct(cfg, target, changes) {
    const raw = (target.raw ?? {}) as Record<string, unknown>;
    const offer: Record<string, unknown> = {
      shop_sku: target.sellerSku,
      product_id: target.retailerSku ?? str(pick(raw, 'product_sku')),
      product_id_type: 'SKU',
      state_code: str(pick(raw, 'state_code')) ?? '11',
      update_delete: 'update',
      price: changes.price ?? target.price,
      quantity: changes.stock ?? num(pick(raw, 'quantity')),
    };
    if (changes.salePrice !== undefined) {
      offer.discount =
        changes.salePrice === null
          ? { price: null }
          : { price: changes.salePrice, start_date: `${changes.saleFrom}T00:00:00-03:00`, end_date: `${changes.saleTo}T23:59:59-03:00` };
    }
    const { json } = await http(`${base(cfg)}/api/offers`, {
      method: 'POST',
      headers: headers(cfg, true),
      body: JSON.stringify({ offers: [offer] }),
      timeoutMs: 60000,
    });
    const id = str(pick(json, 'import_id'));
    if (!id) return { status: 'APLICADO', message: 'Ripley recibió el cambio' } satisfies UpdateResult;
    return { status: 'EN_PROCESO', message: 'Ripley lo está procesando…', reference: id };
  },

  async checkUpdate(cfg, reference) {
    const body = await get(cfg, `/api/offers/imports/${encodeURIComponent(reference)}`);
    const status = String(pick(body, 'status') ?? '').toUpperCase();
    const errors = num(pick(body, 'lines_in_error')) ?? 0;
    if (['WAITING', 'RUNNING', 'QUEUED', 'SENT'].includes(status) || !status) return { status: 'EN_PROCESO', message: 'Ripley lo está procesando…', reference };
    if (status === 'COMPLETE' && !errors) return { status: 'APLICADO', message: 'Ripley aplicó el cambio', reference };
    return {
      status: 'RECHAZADO',
      message: `Ripley rechazó el cambio (${errors || 'con'} error${errors === 1 ? '' : 'es'}). Revisa el detalle del import ${reference} en el portal de Ripley.`,
      reference,
    };
  },
};
