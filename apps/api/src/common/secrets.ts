import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { authSecret } from '../auth/auth.config.js';

/**
 * Las claves de las APIs se guardan cifradas (AES-256-GCM) con una llave derivada de
 * AUTH_SECRET: si alguien copia la base de datos, no ve las claves.
 * Ojo: si se cambia AUTH_SECRET hay que volver a ingresar las claves.
 */
const key = () => createHash('sha256').update(`${authSecret()}:integration`).digest();

export function encryptSecrets(data: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecrets(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const [iv, tag, enc] = value.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')) as Record<string, string>;
  } catch {
    // AUTH_SECRET cambió o el dato está dañado: hay que ingresarlas de nuevo
    return {};
  }
}

/** "abcd1234efgh" -> "••••efgh" */
export const mask = (v: string | undefined) => (v ? `••••${v.slice(-4)}` : null);
