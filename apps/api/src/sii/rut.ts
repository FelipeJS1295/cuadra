/** Utilidades de RUT chileno */

/** "20.279.218-9" -> { body: "20279218", dv: "9" } · null si no es un RUT válido */
export function parseRut(value: string | null | undefined): { body: string; dv: string } | null {
  if (!value) return null;
  const clean = value.replace(/[^0-9kK]/g, '').toUpperCase();
  if (!/^\d{6,9}[0-9K]$/.test(clean)) return null;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  return dvOf(body) === dv ? { body, dv } : null;
}

/** Dígito verificador (módulo 11) */
export function dvOf(body: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const rest = 11 - (sum % 11);
  return rest === 11 ? '0' : rest === 10 ? 'K' : String(rest);
}

/** "20279218-9" (formato que pide el SII) o null si no es válido */
export function siiRut(value: string | null | undefined): string | null {
  const rut = parseRut(value);
  return rut ? `${rut.body}-${rut.dv}` : null;
}

/** RUT genérico del SII para boletas sin cliente identificado */
export const RUT_GENERICO = '66666666-6';
