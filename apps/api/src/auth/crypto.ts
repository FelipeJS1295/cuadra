import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

/**
 * Cifra una contraseña con scrypt (incluido en Node, sin dependencias).
 * Resultado: "scrypt$<sal>$<hash>" en base64.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Compara una contraseña con su hash guardado (en tiempo constante) */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Huella corta del hash de la contraseña: si la contraseña cambia, las sesiones viejas dejan de valer */
export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 12);
}

export interface SessionPayload {
  /** Id del usuario */
  sub: string;
  /** Huella de la contraseña al momento de iniciar sesión */
  pf: string;
  /** Vence (segundos desde 1970) */
  exp: number;
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');

/** Token de sesión firmado con HMAC-SHA256: "<datos>.<firma>" */
export function signSession(payload: SessionPayload, secret: string): string {
  const data = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/** Verifica firma y vencimiento; devuelve los datos o null si el token no sirve */
export function verifySession(token: string, secret: string): SessionPayload | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  const expected = createHmac('sha256', secret).update(data).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (!payload.sub || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}