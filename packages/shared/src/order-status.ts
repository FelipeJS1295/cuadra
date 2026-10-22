/**
 * Estados globales de una orden en Cuadra.
 *
 * Cada retailer informa el estado a su manera ("delivered", "Entregada", "Shipped",
 * "Listo para enviar", "Acknowledged"…). Aquí se traducen todos a un mismo set de
 * estados en español, que es el que se muestra y filtra en todo el sistema.
 *
 * Para agregar un estado nuevo de un retailer: suma la palabra al patrón que corresponda.
 * Los patrones son expresiones regulares (sin distinguir mayúsculas) y se revisan en orden:
 * gana el primero que calce. Sirven igual en JavaScript y en PostgreSQL (operador ~*).
 */

export const ORDER_STATES = ['PENDIENTE', 'EN_PREPARACION', 'EN_CAMINO', 'ENTREGADA', 'DEVUELTA', 'FALLIDA', 'CANCELADA', 'OTRO'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export interface OrderStateInfo {
  label: string;
  /** Color sugerido para mostrarlo */
  tone: 'verde' | 'ambar' | 'rojo' | 'azul' | 'gris';
  /** Qué significa, en palabras simples */
  help: string;
}

export const ORDER_STATE_INFO: Record<OrderState, OrderStateInfo> = {
  PENDIENTE: { label: 'Pendiente', tone: 'ambar', help: 'La orden llegó y aún no se prepara' },
  EN_PREPARACION: { label: 'En preparación', tone: 'azul', help: 'Confirmada, preparando o lista para despachar' },
  EN_CAMINO: { label: 'En camino', tone: 'azul', help: 'Despachada, va hacia el cliente' },
  ENTREGADA: { label: 'Entregada', tone: 'verde', help: 'El cliente la recibió' },
  DEVUELTA: { label: 'Devuelta', tone: 'rojo', help: 'El cliente la devolvió o se le reembolsó' },
  FALLIDA: { label: 'Entrega fallida', tone: 'rojo', help: 'No se pudo entregar' },
  CANCELADA: { label: 'Cancelada', tone: 'gris', help: 'Se anuló: no hay venta' },
  OTRO: { label: 'Otro', tone: 'gris', help: 'Estado del retailer que Cuadra aún no reconoce' },
};

/** Patrón de cada estado (el orden importa: "no entregada" debe ganar antes que "entregada") */
export const ORDER_STATE_PATTERNS: [Exclude<OrderState, 'OTRO'>, string][] = [
  ['CANCELADA', 'cancel|anulad|rechazad|void'],
  ['DEVUELTA', 'devuel|devoluc|return|refund|reembols'],
  ['FALLIDA', 'fallid|failed|no entregad|undeliver|siniestr|perdid|lost'],
  ['ENTREGADA', 'entregad|delivered|finalizad|completad|complete'],
  ['EN_CAMINO', 'shipped|despachad|enviad|tr[aá]nsito|transit|en camino|en ruta'],
  ['EN_PREPARACION', 'listo|ready|acknowledg|confirmad|prepar|pack|por despachar|por enviar|picking|facturad|invoiced|handling'],
  ['PENDIENTE', 'pend|creat|nuev|new|unshipped|pagad|paid|recibid|abiert|open'],
];

/** Patrón de "cancelada", para usar en SQL: coalesce(status, '') ~* CANCELLED_PATTERN */
export const CANCELLED_PATTERN = ORDER_STATE_PATTERNS[0][1];

const compiled = ORDER_STATE_PATTERNS.map(([state, p]) => [state, new RegExp(p, 'i')] as const);

/** Estado global de un estado del retailer (de una línea) */
export function orderStateOf(raw: string | null | undefined): OrderState {
  const text = (raw ?? '').trim();
  if (!text) return 'PENDIENTE';
  for (const [state, re] of compiled) if (re.test(text)) return state;
  return 'OTRO';
}

/** Avance de la entrega: la orden queda en el estado de su línea MENOS avanzada */
const PROGRESS: Record<OrderState, number> = {
  PENDIENTE: 0,
  OTRO: 1,
  EN_PREPARACION: 2,
  EN_CAMINO: 3,
  ENTREGADA: 4,
  DEVUELTA: 5,
  FALLIDA: 5,
  CANCELADA: 9,
};

/**
 * Estado global de una orden con varias líneas:
 *  - todas canceladas → CANCELADA
 *  - alguna devuelta o fallida → ese estado (hay que revisarla)
 *  - si no, el de la línea menos avanzada (ej: una entregada y otra en camino → EN_CAMINO)
 */
export function orderStateOfLines(raws: (string | null | undefined)[]): OrderState {
  const states = (raws.length ? raws : [null]).map(orderStateOf);
  const active = states.filter((s) => s !== 'CANCELADA');
  if (!active.length) return 'CANCELADA';
  if (active.includes('DEVUELTA')) return 'DEVUELTA';
  if (active.includes('FALLIDA')) return 'FALLIDA';
  return active.reduce((a, b) => (PROGRESS[b] < PROGRESS[a] ? b : a));
}
