/**
 * Cálculo del precio sugerido para publicar un producto en cada retailer.
 * Se usa igual en el backend (API) y en el frontend (vista previa al editar).
 *
 * Todo se calcula en NETO (sin IVA), igual que el costo:
 *   1. Neto a recibir  = costo × (1 + % utilidad + % devoluciones)
 *   2. Lo que queda neto de una venta = (precio − comisión − logística) ÷ 1,19
 *      (el IVA de la venta se paga al SII; el IVA de la comisión y la logística se recupera)
 *   3. Despejando:  precio = (neto a recibir × 1,19 + logística) ÷ (1 − % comisión)
 *   4. Se redondea hacia arriba a un precio terminado en 990 (230.222 -> 230.990)
 */

export const VAT_RATE = 0.19;

/** Retailers que aparecen en la tabla de precios de Productos, en orden */
export const PRICING_CHANNELS = [
  { code: 'CENCOSUD', label: 'Paris' },
  { code: 'WALMART', label: 'Walmart' },
  { code: 'FALABELLA', label: 'Falabella' },
  { code: 'HITES', label: 'Hites' },
] as const;

export type PricingChannelCode = (typeof PRICING_CHANNELS)[number]['code'];

/** Valores por defecto al crear un producto */
export const DEFAULT_PROFIT_PCT = 20;
export const DEFAULT_RETURNS_PCT = 5;

/** Redondea hacia arriba a un precio terminado en 990: 230.222 -> 230.990 · 230.990 -> 230.990 */
export function roundUpTo990(value: number): number {
  return Math.ceil((value + 10) / 1000) * 1000 - 10;
}

/** Neto que debemos recibir por unidad: costo × (1 + % utilidad + % devoluciones) */
export function targetNet(cost: number, profitPct: number, returnsPct: number): number {
  return cost * (1 + profitPct / 100 + returnsPct / 100);
}

/** Neto que queda de una venta a ese precio, después de comisión, logística e IVA */
export function netFromPrice(price: number, commissionPct: number, logisticsCost: number): number {
  return (price * (1 - commissionPct / 100) - logisticsCost) / (1 + VAT_RATE);
}

export interface SuggestedPrice {
  /** Precio exacto antes de redondear */
  exact: number;
  /** Precio a publicar, redondeado a ...990 */
  price: number;
  /** Neto que realmente queda al publicar a "price" */
  netAtPrice: number;
}

/**
 * Precio sugerido para un retailer. Devuelve null si falta la comisión
 * o si la comisión es 100% o más (no hay precio posible).
 */
export function suggestedPrice(input: {
  cost: number;
  profitPct: number;
  returnsPct: number;
  commissionPct: number | null;
  logisticsCost: number | null;
}): SuggestedPrice | null {
  const { cost, profitPct, returnsPct, commissionPct } = input;
  if (commissionPct === null || commissionPct >= 100 || cost <= 0) return null;
  const logistics = input.logisticsCost ?? 0;

  const net = targetNet(cost, profitPct, returnsPct);
  const exact = (net * (1 + VAT_RATE) + logistics) / (1 - commissionPct / 100);
  const price = roundUpTo990(exact);
  return { exact, price, netAtPrice: netFromPrice(price, commissionPct, logistics) };
}