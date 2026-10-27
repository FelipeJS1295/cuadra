import { PDFDocument } from 'pdf-lib';
import { findArray, http, num, pick, str } from './util.js';
import { ProviderError, type ProviderConfig } from './types.js';

/**
 * Envíame (https://docs.enviame.io/es/docs/v2): la plataforma logística de Paris.
 * Con la API Key y el ID de empresa (seller) del vendedor:
 *   GET  /api/s1/v1/companies/{seller}/warehouses     bodegas (lugar de retiro)
 *   GET  /api/s1/v1/companies/{seller}/carriers       couriers asignados
 *   GET  /api/s2/v2/companies/{seller}/pickups        retiros agendados
 *   POST /api/s2/v2/companies/{seller}/pickups        crear retiro ("cita")
 *   GET  /api/s2/v2/companies/{seller}/deliveries     envíos (imported_id = N° de la orden)
 *   POST /api/s2/v2/companies/{seller}/labels         etiquetas (y los agrega al manifiesto)
 * Las claves se guardan en la conexión de Paris (enviameApiKey / enviameSellerId).
 */

export interface EnviameWarehouse {
  code: string;
  name: string;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
}
export interface EnviameCarrier {
  code: string;
  name: string;
}
export interface EnviamePickup {
  id: string;
  date: string | null;
  rangeTime: string | null;
  carrier: string | null;
  warehouse: string | null;
  qty: number | null;
  status: string | null;
  statusCode: string | null;
}
export interface PickupInput {
  carrierCode: string;
  warehouseCode: string;
  qty: number;
  weight: number;
  size: 'xs' | 's' | 'm' | 'l' | 'c';
  customSize?: string;
  pickupDate: string;
  rangeTime: 'AM' | 'PM';
  contactName: string;
  contactPhone: string;
}
export interface EnviameDelivery {
  id: string;
  importedId: string | null;
  tracking: string | null;
  carrier: string | null;
  statusId: number | null;
  status: string | null;
  labelPdf: string | null;
}

/** Envío listo para despacho (se puede imprimir la etiqueta) y ya impreso */
const READY = 5;
const PRINTED = 26;

function settings(cfg: ProviderConfig) {
  const apiKey = cfg.secrets.enviameApiKey?.trim();
  const seller = cfg.settings.enviameSellerId?.trim();
  if (!apiKey || !seller) throw new ProviderError('Falta la API Key o el ID de empresa de Envíame (Configuración → Conexiones → Paris)');
  const base = (cfg.settings.enviameBaseUrl || 'https://api.enviame.io').replace(/\/+$/, '');
  return { apiKey, seller: encodeURIComponent(seller), base };
}

async function call(cfg: ProviderConfig, method: string, path: string, body?: unknown) {
  const { apiKey, base } = settings(cfg);
  const { status, json, text } = await http(`${base}${path}`, {
    method,
    headers: { 'api-key': apiKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: 90000,
  }).catch((err) => {
    // http() lanza con el detalle del error; se aclara que vino de Envíame
    throw new ProviderError(`Envíame: ${(err as Error).message}`);
  });
  if (status >= 400) {
    const msg = str(pick(json, 'message', 'error.message', 'error', 'errors.0.message', 'data.message')) ?? text.slice(0, 200);
    throw new ProviderError(
      status === 401
        ? 'Envíame rechazó la API Key (401)'
        : status === 403
          ? 'La API Key de Envíame no tiene permiso para esto (403)'
          : `Envíame respondió ${status}: ${msg}`,
    );
  }
  return (json ?? {}) as Record<string, unknown>;
}

export async function warehouses(cfg: ProviderConfig): Promise<EnviameWarehouse[]> {
  const { seller } = settings(cfg);
  const body = await call(cfg, 'GET', `/api/s1/v1/companies/${seller}/warehouses?limit=100`);
  return findArray(body)
    .filter((w) => pick(w, 'is_active') !== false && !pick(w, 'deleted_at'))
    .map((w) => ({
      code: String(pick(w, 'code', 'identifier', 'id')),
      name: str(pick(w, 'name', 'code')) ?? '',
      address: str(pick(w, 'address.full_address', 'address.place', 'address')),
      contactName: str(pick(w, 'contact_name')),
      contactPhone: str(pick(w, 'contact_phone')),
    }));
}

export async function carriers(cfg: ProviderConfig): Promise<EnviameCarrier[]> {
  const { seller } = settings(cfg);
  const body = await call(cfg, 'GET', `/api/s1/v1/companies/${seller}/carriers`);
  const list = findArray(body);
  // La documentación no muestra el formato: se aceptan objetos ({code,name}) o una lista de códigos
  const raw = list.length ? list : ((pick(body, 'data') as unknown[]) ?? []);
  const out = (Array.isArray(raw) ? raw : []).map((c) =>
    typeof c === 'string'
      ? { code: c, name: c }
      : { code: String(pick(c, 'code', 'carrier.code', 'carrier_code', 'id')), name: str(pick(c, 'name', 'carrier.name', 'code')) ?? '' },
  );
  return out.filter((c) => c.code && c.code !== 'null');
}

export async function pickups(cfg: ProviderConfig, dates: string[]): Promise<EnviamePickup[]> {
  const { seller } = settings(cfg);
  const all: Record<string, unknown>[] = [];
  // Un día por consulta (la API filtra por una fecha); si no hay fechas, los últimos 50
  for (const d of dates.length ? dates : [null]) {
    const q = `limit=50&page=1&order_by=pickup_date&order_type=desc${d ? `&pickup_date=${d}` : ''}`;
    all.push(...findArray(await call(cfg, 'GET', `/api/s2/v2/companies/${seller}/pickups?${q}`)));
  }
  const seen = new Set<string>();
  return all
    .map((p) => ({
      id: String(pick(p, 'identifier', 'id', 'uuid')),
      date: str(pick(p, 'pickup_date'))?.slice(0, 10) ?? null,
      rangeTime: str(pick(p, 'range_time.name', 'range_time', 'range_time.code')),
      carrier: str(pick(p, 'carrier.name', 'carrier.code', 'carrier')),
      warehouse: str(pick(p, 'warehouse.name', 'warehouse.code', 'warehouse_code', 'address.full_address')),
      qty: num(pick(p, 'qty', 'quantity', 'packages')),
      status: str(pick(p, 'status.name', 'status')),
      statusCode: str(pick(p, 'status.code')),
    }))
    .filter((p) => !seen.has(p.id) && seen.add(p.id));
}

export async function createPickup(cfg: ProviderConfig, input: PickupInput) {
  const { seller } = settings(cfg);
  const body = await call(cfg, 'POST', `/api/s2/v2/companies/${seller}/pickups`, {
    carrier_code: input.carrierCode,
    warehouse_code: input.warehouseCode,
    qty: input.qty,
    contact_name: input.contactName,
    contact_phone: input.contactPhone,
    range_time: input.rangeTime,
    pickup_date: input.pickupDate,
    weight: input.weight,
    size: input.size,
    ...(input.size === 'c' && input.customSize ? { custom_size: input.customSize } : {}),
  });
  const d = (pick(body, 'data') ?? body) as Record<string, unknown>;
  return { id: str(pick(d, 'identifier', 'id', 'uuid')), status: str(pick(d, 'status.name', 'status')) };
}

function toDelivery(d: Record<string, unknown>): EnviameDelivery {
  return {
    id: String(pick(d, 'identifier', 'id')),
    importedId: str(pick(d, 'imported_id')),
    tracking: str(pick(d, 'tracking_number')),
    carrier: str(pick(d, 'carrier.name', 'carrier.code', 'carrier')),
    statusId: num(pick(d, 'status.id')),
    status: str(pick(d, 'status.name')),
    labelPdf: str(pick(d, 'label.PDF', 'label.pdf', 'label.url', 'label')),
  };
}

const norm = (s: string | null) => (s ?? '').trim().toUpperCase();

/**
 * Busca en Envíame el envío de cada orden de Paris. El "imported_id" es el N° de orden
 * (sub-orden o la orden completa): primero se recorre la lista de envíos del seller y lo que
 * no aparezca se busca por referencia.
 */
export async function findDeliveries(cfg: ProviderConfig, refs: { key: string; candidates: string[] }[], from: string) {
  const { seller } = settings(cfg);
  const found = new Map<string, EnviameDelivery[]>();
  const wanted = new Map<string, string>();
  for (const r of refs) for (const c of r.candidates) if (c) wanted.set(norm(c), r.key);
  // Sub-orden "ecl123-01" también calza con un envío importado como "ecl123"
  for (const r of refs) for (const c of r.candidates) if (c && !wanted.has(norm(c).replace(/-\d+$/, ''))) wanted.set(norm(c).replace(/-\d+$/, ''), r.key);
  const add = (d: EnviameDelivery, key: string) => {
    const list = found.get(key) ?? [];
    if (!list.some((x) => x.id === d.id)) list.push(d);
    found.set(key, list);
  };

  for (let page = 1; page <= 30; page++) {
    const rows = findArray(await call(cfg, 'GET', `/api/s2/v2/companies/${seller}/deliveries?page=${page}&limit=100&date_from=${from}`));
    for (const row of rows) {
      const d = toDelivery(row);
      const key = wanted.get(norm(d.importedId)) ?? wanted.get(norm(d.importedId).replace(/-\d+$/, ''));
      if (key) add(d, key);
    }
    if (rows.length < 100 || refs.every((r) => found.has(r.key))) break;
  }

  // Lo que no apareció en la lista: búsqueda por referencia
  for (const r of refs.filter((x) => !found.has(x.key))) {
    for (const c of r.candidates) {
      const body = await call(cfg, 'GET', `/api/s2/v2/deliveries/${encodeURIComponent(c)}/tracking?all_matches=true`).catch(() => null);
      const rows = findArray(body);
      for (const row of rows) {
        const id = str(pick(row, 'identifier', 'id', 'delivery_id', 'delivery.id'));
        if (!id) continue;
        const full = await call(cfg, 'GET', `/api/s2/v2/deliveries/${encodeURIComponent(id)}`).catch(() => null);
        if (full) add(toDelivery((pick(full, 'data') ?? full) as Record<string, unknown>), r.key);
      }
      if (found.has(r.key)) break;
    }
  }
  return found;
}

async function fetchPdf(url: string, apiKey: string): Promise<Uint8Array> {
  for (const headers of [{}, { 'api-key': apiKey }] as Record<string, string>[]) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!res?.ok) continue;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (String.fromCharCode(...buf.subarray(0, 4)) === '%PDF') return buf;
  }
  throw new ProviderError('No se pudo descargar la etiqueta desde Envíame');
}

/**
 * Etiquetas de varios envíos en un solo PDF. Los que están "Listo para despacho" se imprimen
 * con POST labels (quedan en el manifiesto); los ya impresos se descargan de su enlace.
 */
export async function labelsPdf(cfg: ProviderConfig, deliveries: EnviameDelivery[]) {
  const { seller, apiKey } = settings(cfg);
  const files: Uint8Array[] = [];
  const toPrint = deliveries.filter((d) => d.statusId === READY);
  const printed = deliveries.filter((d) => d.statusId !== READY);
  let summary: string | null = null;
  if (toPrint.length) {
    const body = await call(cfg, 'POST', `/api/s2/v2/companies/${seller}/labels`, {
      deliveries: toPrint.map((d) => Number(d.id) || d.id),
      type: 'pdf',
      labelsPerPage: 1,
      async: false,
    });
    const d = (pick(body, 'data') ?? body) as Record<string, unknown>;
    const url = str(pick(d, 'url', 'labels', 'labels_url', 'label_url'));
    summary = str(pick(d, 'summary_id', 'summary'));
    if (url?.startsWith('http')) files.push(await fetchPdf(url, apiKey));
    else for (const x of toPrint) if (x.labelPdf) files.push(await fetchPdf(x.labelPdf, apiKey));
  }
  for (const d of printed) {
    if (!d.labelPdf) throw new ProviderError(`El envío ${d.id} no tiene etiqueta todavía (estado: ${d.status ?? 'desconocido'})`);
    files.push(await fetchPdf(d.labelPdf, apiKey));
  }
  const out = await PDFDocument.create();
  for (const f of files) {
    const doc = await PDFDocument.load(f, { ignoreEncryption: true });
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }
  return { pdf: Buffer.from(await out.save()), printedNow: toPrint.length, reprinted: printed.length, summary };
}

export const ENVIAME_STATUS = { READY, PRINTED };
