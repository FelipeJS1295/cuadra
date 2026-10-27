import { createHmac } from 'node:crypto';
import { arr, dayOf, dayRange, http, num, pick, str, toDate } from './util.js';
import {
  ProviderError,
  type LabelOrder,
  type LabelResult,
  type InvoiceUpload,
  type NormalizedItem,
  type NormalizedOrder,
  type NormalizedProduct,
  type ProductChanges,
  type ProviderConfig,
  type RetailProvider,
  type UpdateResult,
} from './types.js';

/** RFC 3986 (como pide Falabella para firmar) */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** "2026-10-21T13:05:09+00:00" */
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * Falabella Seller Center API (https://developers.falabella.com).
 * Cada llamada lleva Action, UserID, Version, Format, Timestamp y Signature =
 * HMAC-SHA256(API Key, parámetros ordenados y codificados).
 */
async function call(cfg: ProviderConfig, action: string, params: Record<string, string> = {}, xml?: string): Promise<Record<string, unknown>> {
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
    method: xml ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': `${sellerId}/Node/${process.versions.node}/PROPIA/FACL`,
      ...(xml ? { 'Content-Type': 'text/xml; charset=utf-8' } : {}),
    },
    body: xml,
    timeoutMs: 90000,
  });
  const body = (json ?? {}) as Record<string, unknown>;
  const error = pick(body, 'ErrorResponse.Head.ErrorMessage');
  if (error) throw new ProviderError(`Falabella: ${String(error)} (código ${String(pick(body, 'ErrorResponse.Head.ErrorCode') ?? '?')})`);
  return body;
}

/**
 * Sube la boleta o factura de una orden (SetInvoicePDF):
 * POST /v1/marketplace-sellers/invoice/pdf, firmado en los encabezados, con el PDF en base64
 * y los OrderItemId de la orden. Falabella solo la acepta si la orden ya está lista para
 * despacho (ready_to_ship o después) y no es Fulfillment (ahí la boleta la hace Falabella).
 */
async function uploadInvoice(cfg: ProviderConfig, input: InvoiceUpload) {
  if (!input.externalOrderId) throw new ProviderError('No se encontró la orden en Falabella: usa "Actualizar ventas" para traerla por API y vuelve a intentar');
  const userId = cfg.settings.userId?.trim();
  const apiKey = cfg.secrets.apiKey?.trim();
  if (!userId || !apiKey) throw new ProviderError('Faltan el usuario (correo) y la API Key de Falabella');

  // Productos de la orden que siguen vigentes (los cancelados no llevan boleta)
  const body = await call(cfg, 'GetOrderItems', { OrderId: input.externalOrderId });
  const items = arr<Record<string, unknown>>(pick(body, 'SuccessResponse.Body.OrderItems.OrderItem', 'SuccessResponse.Body.OrderItems'));
  const ids = items
    .filter((i) => !/cancel|return|fail|devuel/i.test(String(pick(i, 'Status') ?? '')))
    .map((i) => str(pick(i, 'OrderItemId')))
    .filter((x): x is string => Boolean(x));
  if (!ids.length) throw new ProviderError('La orden no tiene productos vigentes en Falabella');

  const headers: Record<string, string> = {
    Action: 'SetInvoicePDF',
    Format: 'JSON',
    Service: 'Invoice',
    Timestamp: isoSeconds(new Date()),
    UserID: userId,
    Version: '1.0',
  };
  const toSign = Object.keys(headers)
    .sort()
    .map((k) => `${enc(k)}=${enc(headers[k])}`)
    .join('&');
  const signature = createHmac('sha256', apiKey).update(toSign).digest('hex');
  const base = (cfg.settings.baseUrl || 'https://sellercenter-api.falabella.com').replace(/\/+$/, '');
  const sellerId = (cfg.settings.sellerId || 'SELLER').replace(/[^\w-]/g, '');
  const payload = {
    orderItemIds: ids,
    invoiceNumber: input.number,
    invoiceDate: input.issuedAt,
    invoiceType: input.type === 'factura' ? 'FACTURA' : 'BOLETA',
    operatorCode: 'FACL',
    invoiceDocumentFormat: 'pdf',
    invoiceDocument: input.pdf.toString('base64'),
  };
  const already = (m: string) => /already exists|ya existe/i.test(m);
  try {
    const { json } = await http(`${base}/v1/marketplace-sellers/invoice/pdf`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `${sellerId}/Node/${process.versions.node}/PROPIA/FACL`,
        ...headers,
        Signature: enc(signature),
      },
      body: JSON.stringify(payload),
      timeoutMs: 90000,
    });
    const error = str(pick(json, 'ErrorResponse.Body.Errors.0.Message', 'ErrorResponse.Body.Errors.Error.Message', 'ErrorResponse.Head.ErrorMessage'));
    if (error) {
      if (already(error)) return { id: null, already: true, raw: json };
      throw new ProviderError(`Falabella: ${error}`);
    }
    return { id: str(pick(json, 'SuccessResponse.Head.RequestId')), already: false, raw: json };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    // El detalle del error viene en ErrorResponse.Body.Errors
    let detail: string | null = null;
    try {
      const j = JSON.parse(err.body ?? '');
      detail = str(pick(j, 'ErrorResponse.Body.Errors.0.Message', 'ErrorResponse.Body.Errors.Error.Message', 'ErrorResponse.Head.ErrorMessage'));
    } catch {
      /* sin JSON */
    }
    if (already(detail ?? err.message)) return { id: null, already: true, raw: null };
    throw detail ? new ProviderError(`Falabella: ${detail}`, err.status) : err;
  }
}

/**
 * Etiquetas de despacho (GetDocument, DocumentType=shippingParcel) con los OrderItemId vigentes
 * de cada orden. Falabella solo la entrega si los productos están empacados: con "pack" se
 * marcan antes (SetStatusToPackedByMarketplace, como hace el portal al imprimir).
 */
async function labels(cfg: ProviderConfig, orders: LabelOrder[], opts: { pack: boolean }): Promise<LabelResult> {
  const out: LabelResult = { files: [], problems: [] };
  for (const o of orders) {
    try {
      if (!o.externalId) throw new ProviderError('No está la orden traída por API: usa "Actualizar ventas"');
      const body = await call(cfg, 'GetOrderItems', { OrderId: o.externalId });
      const items = arr<Record<string, unknown>>(pick(body, 'SuccessResponse.Body.OrderItems.OrderItem', 'SuccessResponse.Body.OrderItems'));
      const ids = items
        .filter((i) => !/cancel|return|fail|devuel/i.test(String(pick(i, 'Status') ?? '')))
        .map((i) => str(pick(i, 'OrderItemId')))
        .filter((x): x is string => Boolean(x));
      if (!ids.length) throw new ProviderError('No tiene productos vigentes (cancelada o devuelta)');
      const itemIds = `[${ids.join(',')}]`;
      const getDoc = () => call(cfg, 'GetDocument', { DocumentType: 'shippingParcel', OrderItemIds: itemIds });
      let doc: Record<string, unknown>;
      try {
        doc = await getDoc();
      } catch (err) {
        const notPacked = /packed|empacad|código 34/i.test((err as Error).message);
        if (!notPacked) throw err;
        if (!opts.pack) throw new ProviderError('Falabella pide marcarla como empacada antes de entregar la etiqueta');
        await call(cfg, 'SetStatusToPackedByMarketplace', { OrderItemIds: itemIds, DeliveryType: 'dropship' });
        doc = await getDoc();
      }
      const d = (pick(doc, 'SuccessResponse.Body.Documents.Document', 'SuccessResponse.Body.Documents.0', 'SuccessResponse.Body.Document') ?? {}) as Record<
        string,
        unknown
      >;
      const file = str(pick(d, 'File'));
      const mime = str(pick(d, 'MimeType')) ?? '';
      if (!file) throw new ProviderError('Falabella no entregó la etiqueta');
      if (!/pdf/i.test(mime)) throw new ProviderError('Tu cuenta de Falabella entrega las etiquetas en ZPL (impresora Zebra). Pide a Falabella el formato PDF');
      out.files.push({ orderNumber: o.orderNumber, pdf: Buffer.from(file, 'base64') });
    } catch (err) {
      out.problems.push({ orderNumber: o.orderNumber, message: (err as Error).message.replace(/^Falabella: /, '') });
    }
  }
  return out;
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
    // Entregado: la última actualización del producto es la entrega
    deliveredAt: /deliver|entregad/i.test(String(pick(i, 'Status') ?? '')) ? toDate(pick(i, 'UpdatedAt')) : null,
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
    dispatchDeadline: dayOf(pick(o, 'PromisedShippingTime')),
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
  uploadInvoice,
  labels,

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
          description: str(pick(p, 'Description')),
          raw: p,
        });
      }
      progress(`Falabella: ${out.length} productos leídos…`);
      if (page.length < 500) break;
    }
    return out;
  },

  editable: ['stock', 'price', 'salePrice', 'name', 'description'],

  /**
   * ProductUpdate (XML por POST). Falabella lo procesa en segundo plano: devuelve un FeedID
   * y el resultado se consulta con FeedStatus (checkUpdate).
   */
  async updateProduct(cfg, target, changes) {
    const body = await call(cfg, 'ProductUpdate', {}, productXml(target.sellerSku, changes));
    const feed = str(pick(body, 'SuccessResponse.Head.RequestId', 'SuccessResponse.Head.RequestID'));
    if (!feed) return { status: 'APLICADO', message: 'Falabella recibió el cambio' };
    return { status: 'EN_PROCESO', message: 'Falabella lo está procesando…', reference: feed };
  },

  async checkUpdate(cfg, reference) {
    const body = await call(cfg, 'FeedStatus', { FeedID: reference });
    const d = (pick(body, 'SuccessResponse.Body.FeedDetail') ?? {}) as Record<string, unknown>;
    const status = String(pick(d, 'Status') ?? '').toLowerCase();
    const errors = arr(pick(d, 'FeedErrors.Error', 'FeedErrors'))
      .map((e) => str(pick(e, 'Message')))
      .filter(Boolean);
    if (status === 'queued' || status === 'processing' || !status) return { status: 'EN_PROCESO', message: 'Falabella lo está procesando…', reference };
    if (status === 'finished' && !errors.length && !(num(pick(d, 'FailedRecords')) ?? 0)) {
      return { status: 'APLICADO', message: 'Falabella aplicó el cambio', reference };
    }
    return {
      status: 'RECHAZADO',
      message: `Falabella: ${errors.join(' · ') || `terminó con estado ${String(pick(d, 'Status'))}`}`,
      reference,
    } satisfies UpdateResult;
  },
};

const xmlText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** "2026-10-22 00:00:00" */
const fdate = (d: string, end = false) => `${d} ${end ? '23:59:59' : '00:00:00'}`;

function productXml(sellerSku: string, c: ProductChanges) {
  const tag = (name: string, v: string | number | null | undefined) => (v === undefined ? '' : `<${name}>${v === null ? '' : xmlText(String(v))}</${name}>`);
  // Precios, oferta y stock van por unidad de negocio (Falabella Chile = facl)
  const bu = [
    tag('Price', c.price === undefined ? undefined : Math.round(c.price)),
    c.salePrice === undefined ? '' : tag('SpecialPrice', c.salePrice === null ? null : Math.round(c.salePrice)),
    c.salePrice ? tag('SpecialFromDate', c.saleFrom ? fdate(c.saleFrom) : undefined) + tag('SpecialToDate', c.saleTo ? fdate(c.saleTo, true) : undefined) : '',
    c.salePrice === null ? tag('SpecialFromDate', null) + tag('SpecialToDate', null) : '',
    tag('Stock', c.stock === undefined ? undefined : Math.max(0, Math.round(c.stock))),
  ].join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" ?><Request><Product>' +
    tag('SellerSku', sellerSku) +
    tag('Name', c.name) +
    tag('Description', c.description) +
    (bu ? `<BusinessUnits><BusinessUnit><OperatorCode>facl</OperatorCode>${bu}</BusinessUnit></BusinessUnits>` : '') +
    '</Product></Request>'
  );
}
