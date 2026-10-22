/**
 * Paquete compartido entre backend (apps/api) y frontend (apps/web).
 * Aquí viven los schemas Zod y tipos que ambos lados deben respetar,
 * para que un cambio en el contrato de la API se detecte al compilar.
 */
export * from './health.js';
export * from './pricing.js';export * from './order-status.js';
