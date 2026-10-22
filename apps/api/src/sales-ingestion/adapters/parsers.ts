/**
 * Funciones para limpiar los valores que vienen en los Excel de los retailers.
 * Se reutilizan entre adaptadores (Falabella, Cencosud, ...).
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // por si algún retailer los trae en español
  ene: 1, abr: 4, ago: 8, dic: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Texto limpio: quita espacios; vacío -> null */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Convierte a fecha sin hora, en formato que entiende Postgres (AAAA-MM-DD).
 * En pantalla se muestra como DD/MM/AAAA.
 * Acepta:
 *   "Oct 5, 2026 00:49"  (Falabella)
 *   "05/10/2026"         (DD/MM/AAAA)
 *   "2026-10-05"         (AAAA-MM-DD)
 *   Date de Excel
 */
export function toDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Excel guarda fechas sin zona horaria: se usan los componentes UTC tal cual
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }

  const text = toText(value);
  if (!text) return null;

  let year: number, month: number, day: number;

  const english = text.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/);
  const latin = text.match(/^(\d{1,2})[/_-](\d{1,2})[/_-](\d{4})/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (english) {
    month = MONTHS[english[1].toLowerCase()];
    day = Number(english[2]);
    year = Number(english[3]);
  } else if (latin) {
    day = Number(latin[1]);
    month = Number(latin[2]);
    year = Number(latin[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    throw new Error(`Fecha no reconocida: "${text}"`);
  }

  // Valida que la fecha exista (ej: rechaza 31/02)
  const check = new Date(Date.UTC(year, month - 1, day));
  if (!month || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Fecha inválida: "${text}"`);
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Convierte un monto a texto numérico exacto para Postgres (numeric).
 * Formato Falabella: "195,990.00" -> "195990.00" (coma = miles, punto = decimal).
 * Se devuelve como texto para no perder precisión con decimales de JavaScript.
 */
export function toAmount(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Monto inválido: ${value}`);
    return String(value);
  }
  const text = toText(value);
  if (!text) return null;

  const clean = text.replace(/[$\s]/g, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`Monto no reconocido: "${text}"`);
  }
  return clean;
}

/** Número entero (ej: cantidad). "2", 2, "2.0" -> 2; vacío -> null */
export function toInteger(value: unknown): number | null {
  const amount = toAmount(value);
  if (amount === null) return null;
  const n = Number(amount);
  if (!Number.isInteger(n)) throw new Error(`Se esperaba un número entero: "${String(value)}"`);
  return n;
}

/** Une varias partes de texto (ej: calle + número + depto), ignorando las vacías */
export function joinText(...parts: unknown[]): string | null {
  const joined = parts.map(toText).filter(Boolean).join(' ');
  return joined === '' ? null : joined;
}