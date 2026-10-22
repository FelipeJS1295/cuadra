import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * Configuración de sesiones. Se lee del .env AL USARSE (no al importar el archivo),
 * porque el .env se carga cuando parte la app, después de importar los módulos.
 */

/** Nombre de la cookie de sesión */
export const SESSION_COOKIE = 'cuadra_session';

/** Cookie con la empresa elegida (si el usuario tiene varias) */
export const TENANT_COOKIE = 'cuadra_empresa';

/** Días que dura una sesión (SESSION_DAYS, por defecto 7) */
export const sessionDays = () => Number(process.env.SESSION_DAYS ?? 7);

/** Cookie "Secure" (solo HTTPS). Activar en producción con COOKIE_SECURE=true */
export const cookieSecure = () => process.env.COOKIE_SECURE === 'true';

let cachedSecret: string | null = null;

/** Clave para firmar las sesiones (AUTH_SECRET) */
export function authSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv) return (cachedSecret = fromEnv);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Falta AUTH_SECRET en el .env (una frase larga y secreta para firmar las sesiones)');
  }
  // En desarrollo se inventa una: las sesiones se pierden al reiniciar la API
  Logger.warn('AUTH_SECRET no está definido: se usa uno temporal (agrégalo al .env)', 'Auth');
  return (cachedSecret = randomBytes(32).toString('hex'));
}