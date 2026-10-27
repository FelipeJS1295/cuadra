/**
 * Calendario de pagos de los retailers: cuándo debería llegar la plata de cada venta.
 *
 *   DIAS             N días corridos desde la venta o el despacho (regla genérica)
 *   QUINCENAL        Walmart: cierra el 14 y el último día del mes; paga N días hábiles después del cierre
 *   HABILES_ENTREGA  Falabella: N días hábiles después de que el cliente recibe el producto
 *   SEMANAL          Paris: cada semana, el día elegido (miércoles) paga lo entregado la semana anterior
 *
 * Días hábiles = lunes a viernes sin feriados de Chile.
 */

export const PAYMENT_RULES = ['DIAS', 'QUINCENAL', 'HABILES_ENTREGA', 'SEMANAL'] as const;
export type PaymentRule = (typeof PAYMENT_RULES)[number];

export const PAYMENT_RULE_LABELS: Record<PaymentRule, string> = {
  DIAS: 'A días corridos',
  QUINCENAL: 'Quincenal (cierra el 14 y fin de mes)',
  HABILES_ENTREGA: 'Días hábiles después de la entrega',
  SEMANAL: 'Una vez por semana',
};

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Feriados nacionales de Chile (AAAA-MM-DD). Para años que no están, solo se descuentan
 * los fines de semana y los feriados de fecha fija.
 */
const HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01', '2025-04-18', '2025-04-19', '2025-05-01', '2025-05-21', '2025-06-20', '2025-06-29', '2025-07-16',
  '2025-08-15', '2025-09-18', '2025-09-19', '2025-10-12', '2025-10-31', '2025-11-01', '2025-11-16', '2025-12-08',
  '2025-12-14', '2025-12-25',
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-04', '2026-05-01', '2026-05-21', '2026-06-21', '2026-06-29', '2026-07-16',
  '2026-08-15', '2026-09-18', '2026-09-19', '2026-10-12', '2026-10-31', '2026-11-01', '2026-12-08', '2026-12-25',
  // 2027
  '2027-01-01', '2027-03-26', '2027-03-27', '2027-05-01', '2027-05-21', '2027-06-21', '2027-06-28', '2027-07-16',
  '2027-08-15', '2027-09-17', '2027-09-18', '2027-09-19', '2027-10-11', '2027-10-31', '2027-11-01', '2027-12-08',
  '2027-12-25',
]);
const FIXED = ['01-01', '05-01', '05-21', '07-16', '08-15', '09-18', '09-19', '11-01', '12-08', '12-25'];
const KNOWN_YEARS = new Set(['2025', '2026', '2027']);

const parse = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDaysIso(d: string, n: number) {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
}

export function isBusinessDay(d: string) {
  const wd = parse(d).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const day = d.slice(0, 10);
  if (HOLIDAYS.has(day)) return false;
  if (!KNOWN_YEARS.has(day.slice(0, 4)) && FIXED.includes(day.slice(5))) return false;
  return true;
}

/** N días hábiles después de una fecha (sin contarla) */
export function addBusinessDays(d: string, n: number) {
  let cur = d.slice(0, 10);
  let left = n;
  while (left > 0) {
    cur = addDaysIso(cur, 1);
    if (isBusinessDay(cur)) left--;
  }
  return cur;
}

/** Si cae en día no hábil, el siguiente hábil */
export function nextBusinessDay(d: string) {
  let cur = d.slice(0, 10);
  while (!isBusinessDay(cur)) cur = addDaysIso(cur, 1);
  return cur;
}

export interface PaymentTerms {
  rule: PaymentRule;
  /** DIAS: días corridos · QUINCENAL / HABILES_ENTREGA: días hábiles */
  days: number;
  /** SEMANAL: día de pago (0 = domingo … 3 = miércoles) */
  weekday: number;
  /** DIAS: desde la venta o el despacho */
  base: 'ORDEN' | 'DESPACHO';
}

export interface SaleDates {
  orderDate: string | null;
  /** Fecha en que el cliente recibió el producto (si se sabe) */
  deliveredAt: string | null;
  /** Fecha límite de despacho (para estimar la entrega) */
  dispatchDeadline: string | null;
  /** La orden ya figura como entregada (aunque no se sepa la fecha exacta) */
  delivered: boolean;
}

export interface ExpectedPayment {
  date: string | null;
  /** La fecha depende de una entrega que aún no ocurre o de la que no se sabe el día */
  estimated: boolean;
  /** Explicación corta, para mostrar */
  why: string;
}

/** Días que se suponen entre el despacho y la entrega cuando no se sabe la entrega real */
const DELIVERY_GUESS = 3;

/** Fecha de entrega conocida o estimada */
function deliveryOf(s: SaleDates): { date: string | null; estimated: boolean } {
  if (s.deliveredAt) return { date: s.deliveredAt.slice(0, 10), estimated: false };
  const from = s.dispatchDeadline ?? s.orderDate;
  if (!from) return { date: null, estimated: true };
  return { date: addBusinessDays(from, DELIVERY_GUESS), estimated: true };
}

const dmy = (d: string) => d.slice(0, 10).split('-').reverse().join('/');

/** Cuándo debería pagar el retailer esta venta */
export function expectedPayment(t: PaymentTerms, s: SaleDates): ExpectedPayment {
  if (t.rule === 'DIAS') {
    const base = t.base === 'DESPACHO' ? (s.dispatchDeadline ?? s.orderDate) : s.orderDate;
    if (!base) return { date: null, estimated: true, why: 'Sin fecha de venta' };
    return { date: addDaysIso(base, t.days), estimated: false, why: `${t.days} días desde ${t.base === 'DESPACHO' ? 'el despacho' : 'la venta'}` };
  }
  const del = deliveryOf(s);
  if (!del.date) return { date: null, estimated: true, why: 'Sin fechas para calcular' };
  const pending = !s.deliveredAt && !s.delivered;
  const tag = s.deliveredAt ? `entregada el ${dmy(s.deliveredAt)}` : pending ? 'si se entrega a tiempo' : 'entrega sin fecha exacta';

  if (t.rule === 'HABILES_ENTREGA') {
    return { date: addBusinessDays(del.date, t.days), estimated: del.estimated, why: `${t.days} días hábiles después de la entrega (${tag})` };
  }
  if (t.rule === 'QUINCENAL') {
    // Período 1–14 cierra el 14; período 15–fin cierra el último día del mes (según la entrega)
    const d = parse(del.date);
    const day = d.getUTCDate();
    const close = day <= 14 ? iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 14, 12))) : iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
    return {
      date: addBusinessDays(close, t.days),
      estimated: del.estimated,
      why: `Liquidación ${day <= 14 ? '1 al 14' : '15 a fin de mes'} (cierra ${dmy(close)}), paga ${t.days} días hábiles después`,
    };
  }
  // SEMANAL: lo entregado una semana (lunes a domingo) se paga el día elegido de la semana siguiente
  const d = parse(del.date);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  const nextMonday = addDaysIso(del.date, 7 - mondayOffset);
  const pay = nextBusinessDay(addDaysIso(nextMonday, (t.weekday + 6) % 7));
  return { date: pay, estimated: del.estimated, why: `Paga los ${WEEKDAYS[t.weekday]} lo entregado la semana anterior (${tag})` };
}

/** Texto corto de las condiciones de pago */
export function paymentTermsLabel(t: PaymentTerms) {
  switch (t.rule) {
    case 'QUINCENAL':
      return `Quincenal: cierra el 14 y fin de mes, paga ${t.days} días hábiles después`;
    case 'HABILES_ENTREGA':
      return `Paga ${t.days} días hábiles después de la entrega`;
    case 'SEMANAL':
      return `Paga los ${WEEKDAYS[t.weekday]} lo entregado la semana anterior`;
    default:
      return `Paga a ${t.days} días desde ${t.base === 'DESPACHO' ? 'el despacho' : 'la venta'}`;
  }
}
