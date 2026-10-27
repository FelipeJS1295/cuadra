import { ProviderError } from './types.js';

/** fetch con tiempo máximo y error legible (incluye lo que respondió el retailer) */
export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; text: string; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new ProviderError(`No se pudo conectar con ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* no es JSON */
  }
  if (!res.ok) {
    const msg = errorText(json) ?? text.slice(0, 300);
    throw new ProviderError(`${new URL(url).host} respondió ${res.status}${msg ? `: ${msg}` : ''}`, res.status, text.slice(0, 2000));
  }
  return { status: res.status, text, json };
}

function errorText(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const v =
    o.message ??
    o.error_description ??
    o.error ??
    o.detail ??
    (o.errors as unknown) ??
    (o.ErrorResponse as { Head?: { ErrorMessage?: string } } | undefined)?.Head?.ErrorMessage;
  if (!v) return null;
  return typeof v === 'string' ? v : JSON.stringify(v).slice(0, 300);
}

/** Valor en una ruta "a.b.c" (null si no está) */
export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? null;
}

/** Primer valor no vacío entre varias rutas */
export function pick(obj: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    const v = get(obj, p);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

export const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v).trim());

/** "349990.00" / "349.990" / 349990 -> 349990 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Siempre arreglo (las APIs a veces devuelven un objeto suelto cuando hay uno solo) */
export const arr = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? [v as T] : []);

/** Busca en todo el objeto el primer campo cuyo nombre calza (ej: RUT del cliente) */
export function findDeep(obj: unknown, key: RegExp, depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (key.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = findDeep(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Primer arreglo de objetos dentro de la respuesta */
export function findArray(body: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || !body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body.every((x) => x && typeof x === 'object') ? (body as Record<string, unknown>[]) : [];
  for (const key of ['data', 'items', 'orders', 'results', 'content', 'elements', 'list', 'products']) {
    const v = (body as Record<string, unknown>)[key];
    const rows = findArray(v, depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

/** Desfase de Chile (en minutos) en una fecha dada */
function chileOffset(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return (asUtc - date.getTime()) / 60000;
}

/**
 * Fecha de la API -> Date. Acepta epoch (ms), ISO con zona, o "AAAA-MM-DD HH:MM:SS" sin zona
 * (se toma como hora de Chile).
 */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  const s = String(v).trim();
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s));
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return new Date(naive - chileOffset(new Date(naive)) * 60000);
}

/** Inicio y fin del día en Chile, como Date */
export function dayRange(from: string, to: string) {
  const start = toDate(`${from} 00:00:00`)!;
  const end = toDate(`${to} 23:59:59`)!;
  return { start, end };
}

/**
 * Día (AAAA-MM-DD) de una fecha informada por el retailer, sin correrlo por la zona horaria:
 * "2026-10-26" o "2026-10-23 23:00:00" -> ese día; un instante con zona -> el día en Chile;
 * un timestamp a medianoche UTC (Walmart: estimatedShipDate) -> ese día.
 */
export function dayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 10);
  const d = toDate(v);
  if (!d) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d);
}
