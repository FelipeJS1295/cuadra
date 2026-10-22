import { BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Validaciones comunes de las maestras de productos e insumos.
 */

/** SKU: texto sin espacios a los lados, se guarda en MAYÚSCULAS */
export const skuSchema = z
  .string({ error: 'El SKU es obligatorio' })
  .trim()
  .min(1, 'El SKU es obligatorio')
  .max(60, 'El SKU puede tener máximo 60 caracteres')
  .transform((s) => s.toUpperCase());

export const nameSchema = z
  .string({ error: 'El nombre es obligatorio' })
  .trim()
  .min(1, 'El nombre es obligatorio')
  .max(200, 'El nombre puede tener máximo 200 caracteres');

/**
 * Costo neto en pesos: acepta 12500, "12500", "12.500" o "12500,5".
 * Se devuelve como texto exacto para Postgres (numeric).
 */
export const costSchema = z
  .union([z.number(), z.string()], { error: 'El costo es obligatorio' })
  .transform((value, ctx) => {
    const text =
      typeof value === 'number'
        ? String(value)
        : value.trim().replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
    const n = Number(text);
    if (text === '' || !Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: 'custom', message: 'El costo debe ser un número mayor o igual a 0' });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

/** Convierte "20", "20,5", 20.5 o "" a número (o null si viene vacío) */
function parseLooseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(/[%\s]/g, '').replace(',', '.');
  return text === '' ? null : Number(text);
}

/** Porcentaje entre 0 y 99,99 (ej: comisión, utilidad). Acepta "20", "20,5", 20.5 */
export const percentSchema = z
  .union([z.number(), z.string()], { error: 'Porcentaje inválido' })
  .transform((value, ctx) => {
    const n = parseLooseNumber(value);
    if (n === null || !Number.isFinite(n) || n < 0 || n >= 100) {
      ctx.addIssue({ code: 'custom', message: 'El porcentaje debe estar entre 0 y 99,99' });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

/** Igual que percentSchema, pero vacío -> null (ej: comisión aún no definida) */
export const optionalPercentSchema = z
  .union([z.number(), z.string(), z.null()])
  .transform((value, ctx) => {
    const n = parseLooseNumber(value);
    if (n === null) return null;
    if (!Number.isFinite(n) || n < 0 || n >= 100) {
      ctx.addIssue({ code: 'custom', message: 'La comisión debe estar entre 0 y 99,99%' });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

/** Monto opcional (ej: logística): igual que costSchema, pero vacío -> null */
export const optionalCostSchema = z
  .union([z.number(), z.string(), z.null()])
  .transform((value, ctx) => {
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
    const result = costSchema.safeParse(value);
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: 'La logística debe ser un monto mayor o igual a 0' });
      return z.NEVER;
    }
    return result.data;
  });

/** Valida el body con zod; si falla, responde 400 con los mensajes en español */
export function validate<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.message).join('. '));
  }
  return result.data;
}

/**
 * Si Postgres rechaza por SKU repetido (código 23505), responde 409 con un mensaje claro.
 * Drizzle envuelve el error de pg, por eso se revisa también `cause`.
 */
export function rethrowDuplicate(err: unknown, sku: string): never {
  const code =
    (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  if (code === '23505') throw new ConflictException(`Ya existe el SKU "${sku}"`);
  throw err;
}