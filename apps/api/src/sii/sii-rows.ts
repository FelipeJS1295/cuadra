/** Lectura tolerante de las filas que entrega el SII / API Gateway (los nombres de campos varían) */

/** "Monto Neto" / "detMntNeto" / "monto_neto" -> "montoneto" / "detmntneto" */
export const normKey = (k: string) =>
  k
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Monto: número o texto ("1234", "1.234", "-1234") */
export function amount(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** "05/10/2026", "2026-10-05", "05-10-2026 10:22:01" -> "2026-10-05" */
export function isoDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Busca el primer campo con valor entre varios nombres posibles */
export function picker(row: Record<string, unknown>) {
  const map = new Map(Object.entries(row).map(([k, v]) => [normKey(k), v]));
  return (...names: string[]) => {
    for (const n of names) {
      const v = map.get(n);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
}

/** Solo el número del RUT ("76.192.083-9" / 76192083 -> "76192083") */
export const rutBody = (v: unknown) => (v === undefined || v === null ? '' : String(v).split('-')[0].replace(/[^\dkK]/g, ''));

/** Documento de un listado del Portal MIPYME (emitidos / recibidos) */
export interface PortalDoc {
  code: string;
  type: number;
  rutBody: string;
  rut: string;
  name: string | null;
  folio: string;
  date: string | null;
  /** null si el listado no trae el monto */
  total: number | null;
}

export function portalDoc(row: Record<string, unknown>): PortalDoc | null {
  const pick = picker(row);
  const code = pick('codigo', 'code', 'ehdrcodigo');
  const type = Number(pick('dte', 'tipodte', 'tipo', 'ptdccodigo'));
  const folio = pick('folio', 'nrodoc');
  if (code === undefined || !type || folio === undefined) return null;
  const body = rutBody(pick('rut', 'rutemisor', 'rutreceptor', 'rutrecep'));
  const dv = pick('dv', 'dvemisor', 'dvreceptor', 'dvrecep');
  const total = pick('total', 'montototal', 'mnttotal', 'monto', 'mntotal');
  return {
    code: String(code),
    type,
    rutBody: body,
    rut: dv !== undefined ? `${body}-${String(dv).toUpperCase()}` : body,
    name: (pick('razonsocial', 'rznsoc', 'nombre') as string | undefined) ?? null,
    folio: String(folio).trim(),
    date: isoDate(pick('fecha', 'fchemis', 'fechaemision')),
    total: total === undefined ? null : Math.round(amount(total)),
  };
}
