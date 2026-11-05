import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../company/settings.service.js';
import { SiiRejectedError, SiiUnknownError, type EboletaInput, type EboletaResult } from '../api-gateway.client.js';

/**
 * Conexión DIRECTA con "Boleta electrónica" del SII (eboleta.sii.cl), con el RUT y la clave
 * tributaria de una persona autorizada de la empresa. Es lo mismo que hace la página del SII
 * en el navegador (y lo que hacía API Gateway por nosotros):
 *
 *   1. POST clave.w.sii.cl/oauthsii-v1-ms/authorization/v1/authorize   { user, password, … } → code
 *   2. POST <sign-in>/prod/sign-in   { opts: { code, state, authMethod: 'clave-tributaria' } } → openId
 *   3. Cognito GetCredentialsForIdentity(openId) → credenciales temporales de AWS (1 hora)
 *   4. Llamadas firmadas (AWS SigV4) a la API de eBoleta:
 *        GET  info-contribuyente/info-emisor-usuario/<rut empresa>/<rut usuario>   datos y sucursales
 *        POST dte/documentos/generar   la boleta → { folio, dte, pdf_public_url, b64encoded_pdf }
 *
 * Los hosts son los de la página del SII; se pueden cambiar con variables de entorno si el SII los mueve.
 */

const CLIENT_ID = process.env.SII_EBOLETA_CLIENT_ID || 'e0378e96-4014-4a47-b852-9d9246797f5c';
const REDIRECT = 'https://eboleta.sii.cl/emitir/';
const OAUTH = (process.env.SII_EBOLETA_OAUTH || 'https://clave.w.sii.cl/oauthsii-v1-ms/authorization/v1').replace(/\/+$/, '');
const SIGN_IN = process.env.SII_EBOLETA_SIGNIN || 'https://x78kr8nqx5.execute-api.us-east-1.amazonaws.com/prod/sign-in';
const API = (process.env.SII_EBOLETA_API || 'https://cn68i6qm0g.execute-api.us-east-1.amazonaws.com/prod/api').replace(/\/+$/, '');
const COGNITO = process.env.SII_EBOLETA_COGNITO || 'https://cognito-identity.us-east-1.amazonaws.com/';
const REGION = 'us-east-1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BROWSER = { 'User-Agent': UA, Origin: 'https://eboleta.sii.cl', Referer: 'https://eboleta.sii.cl/' };

interface AwsCreds {
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  /** ms */
  expires: number;
}
interface Session {
  creds: AwsCreds;
  identityId: string;
  /** Token de Cognito (vale 12 h): con él se renuevan las credenciales sin volver a entrar */
  openIdToken: string;
  openIdExpires: number;
}
export interface EmisorDirecto {
  rut: number;
  dv: string;
  razonSocial: string;
  giro: string | null;
  numeroResolucion: number | null;
  fechaResolucion: string | null;
  tiposDte: { codigo: number; nombre: string }[];
  sucursales: { codigo: number; direccion: string; nombre_comuna?: string }[];
  [k: string]: unknown;
}

/** "76.990.942-7" -> ["76990942", "7"] */
function split(rut: string): [string, string] {
  const clean = rut.replace(/\./g, '').toUpperCase();
  const [body, dv] = clean.includes('-') ? clean.split('-') : [clean.slice(0, -1), clean.slice(-1)];
  return [body, dv];
}
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
/** RFC 3986 (lo que exige SigV4 en la ruta) */
const encodePath = (p: string) =>
  p
    .split('/')
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');

/** Firma AWS Signature V4 para API Gateway (servicio execute-api) */
export function signV4(method: string, url: string, body: string, creds: AwsCreds, now = new Date()) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const service = 'execute-api';
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers: Record<string, string> = { host: u.host, 'x-amz-date': amzDate, 'x-amz-security-token': creds.sessionToken };
  const names = Object.keys(headers).sort();
  const canonical = [method, encodePath(u.pathname), query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), sha256(body)].join('\n');
  const scope = `${day}/${REGION}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretKey}`, day), REGION), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    'X-Amz-Date': amzDate,
    'X-Amz-Security-Token': creds.sessionToken,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

@Injectable()
export class EboletaDirectClient {
  private readonly logger = new Logger(EboletaDirectClient.name);
  /** Sesión por empresa + usuario */
  private readonly sessions = new Map<string, Session>();
  private readonly emisores = new Map<string, { at: number; data: EmisorDirecto }>();

  constructor(private readonly settings: SettingsService) {}

  private async config() {
    const s = await this.settings.sii();
    if (!s.emisorRut || !s.usuarioRut || !s.clave)
      throw new SiiRejectedError('Falta el RUT de la empresa, el RUT de la persona o la clave del SII (Configuración → SII)');
    return { emisorRut: s.emisorRut, userRut: s.usuarioRut, clave: s.clave, sucursal: s.sucursal, key: `${this.settings.tenantId()}|${s.usuarioRut}` };
  }

  private async fetchJson(url: string, init: RequestInit, timeoutMs = 45000): Promise<{ status: number; body: unknown; text: string }> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      throw new SiiRejectedError(`No se pudo conectar con el SII (${code || (err as Error).message})`);
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    return { status: res.status, body, text };
  }

  /** Entra a eBoleta con RUT y clave: devuelve credenciales de AWS (se reutilizan mientras duren) */
  private async session(force = false): Promise<Session> {
    const c = await this.config();
    const cached = this.sessions.get(c.key);
    const now = Date.now();
    if (!force && cached && cached.creds.expires - now > 5 * 60_000) return cached;
    // El token de Cognito dura 12 h: renueva las credenciales sin volver a escribir la clave
    if (!force && cached && cached.openIdExpires - now > 10 * 60_000) {
      try {
        const creds = await this.credentials(cached.identityId, cached.openIdToken);
        const s = { ...cached, creds };
        this.sessions.set(c.key, s);
        return s;
      } catch {
        /* entra de nuevo */
      }
    }

    const [body] = split(c.userRut);
    const state = randomUUID();
    const pre = await this.fetchJson(
      `${OAUTH}/validatePreLogin/?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=user_info&state=${state}`,
      { headers: { 'User-Agent': UA, Referer: 'https://clave.w.sii.cl/' } },
    );
    if ((pre.body as { reCaptchaEnabled?: boolean } | null)?.reCaptchaEnabled) {
      throw new SiiRejectedError('El SII está pidiendo captcha para entrar a Boleta electrónica: por ahora se emite por API Gateway');
    }
    const auth = await this.fetchJson(`${OAUTH}/authorize`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://clave.w.sii.cl', Referer: 'https://clave.w.sii.cl/' },
      body: JSON.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        scope: 'user_info',
        state,
        user: body,
        password: c.clave,
        token_captcha: '0',
        action_captcha: 'login',
      }),
    });
    const a = (auth.body ?? {}) as { redirect_uri?: string; action?: string; message?: string; error?: string; description?: string };
    const code = a.redirect_uri ? new URL(a.redirect_uri).searchParams.get('code') : null;
    if (!code) {
      const why = a.message || a.description || a.error || (a.action && a.action !== 'AUT' ? `el SII pide "${a.action}"` : '');
      throw new SiiRejectedError(`El SII no aceptó el RUT o la clave${why ? `: ${why}` : ''} (${auth.status})`);
    }

    const sign = await this.fetchJson(SIGN_IN, {
      method: 'POST',
      headers: { ...BROWSER, 'Content-Type': 'application/json; charset=UTF-8', 'X-Amz-Date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, '') },
      body: JSON.stringify({ rut: '', opts: { code, state, authMethod: 'clave-tributaria' } }),
    });
    const open = (sign.body as { openId?: { IdentityId?: string; Token?: string } } | null)?.openId;
    if (!open?.IdentityId || !open.Token) throw new SiiRejectedError(`No se pudo entrar a Boleta electrónica (${sign.status}): ${sign.text.slice(0, 200)}`);
    let openIdExpires = now + 11 * 3600_000;
    try {
      const exp = JSON.parse(Buffer.from(open.Token.split('.')[1], 'base64url').toString()).exp;
      if (Number.isFinite(exp)) openIdExpires = exp * 1000;
    } catch {
      /* usa 11 h */
    }
    const creds = await this.credentials(open.IdentityId, open.Token);
    const s: Session = { creds, identityId: open.IdentityId, openIdToken: open.Token, openIdExpires };
    this.sessions.set(c.key, s);
    return s;
  }

  private async credentials(identityId: string, token: string): Promise<AwsCreds> {
    const r = await this.fetchJson(COGNITO, {
      method: 'POST',
      headers: { ...BROWSER, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity' },
      body: JSON.stringify({ IdentityId: identityId, Logins: { 'cognito-identity.amazonaws.com': token } }),
    });
    const k = (r.body as { Credentials?: { AccessKeyId?: string; SecretKey?: string; SessionToken?: string; Expiration?: number } } | null)?.Credentials;
    if (!k?.AccessKeyId || !k.SecretKey || !k.SessionToken) throw new SiiRejectedError(`No se obtuvieron las credenciales de Boleta electrónica (${r.status})`);
    return { accessKeyId: k.AccessKeyId, secretKey: k.SecretKey, sessionToken: k.SessionToken, expires: (k.Expiration ?? Date.now() / 1000 + 3000) * 1000 };
  }

  /** Llamada firmada a la API de eBoleta (reintenta una vez con sesión nueva si las credenciales vencieron) */
  private async call(method: 'GET' | 'POST', path: string, payload?: unknown, opts: { timeoutMs?: number; contentType?: string } = {}) {
    const url = `${API}${path}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const send = async (s: Session) => {
      const headers: Record<string, string> = { ...BROWSER, Accept: 'application/json, text/plain, */*', ...signV4(method, url, body, s.creds) };
      if (payload !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
      return fetch(url, { method, headers, body: payload === undefined ? undefined : body, signal: AbortSignal.timeout(opts.timeoutMs ?? 45000) });
    };
    let res = await send(await this.session());
    if (res.status === 401 || res.status === 403) res = await send(await this.session(true));
    return res;
  }

  /** Datos de la empresa para este usuario: razón social, giro, resolución, sucursales */
  async emisor(refresh = false): Promise<EmisorDirecto> {
    const c = await this.config();
    const hit = this.emisores.get(c.key);
    if (!refresh && hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;
    const [rut] = split(c.emisorRut);
    let res: Response;
    try {
      res = await this.call('GET', `/info-contribuyente/info-emisor-usuario/${rut}/${c.userRut}`);
    } catch (err) {
      if (err instanceof SiiRejectedError) throw err;
      throw new SiiRejectedError(`No se pudieron leer los datos de la empresa en Boleta electrónica: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new SiiRejectedError(`Boleta electrónica no entregó los datos de la empresa (${res.status}): ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as EmisorDirecto;
    this.emisores.set(c.key, { at: Date.now(), data });
    return data;
  }

  /** Emite la boleta igual que la página del SII */
  async emitirBoleta(input: EboletaInput): Promise<EboletaResult> {
    const c = await this.config();
    const info = await this.emisor();
    if (!info.tiposDte?.some((t) => t.codigo === input.tipo)) {
      throw new SiiRejectedError(`La empresa no tiene habilitado el documento ${input.tipo} en Boleta electrónica`);
    }
    const fixed = Number(c.sucursal);
    const sucursal = c.sucursal && Number.isFinite(fixed) ? fixed : Number(info.sucursales?.[0]?.codigo);
    if (!Number.isFinite(sucursal)) throw new SiiRejectedError('La empresa no tiene sucursales en Boleta electrónica');

    const dte = {
      vendedor: c.userRut,
      Encabezado: {
        // El SII asigna el folio (la página manda 1). La fecha: la de la orden, como la mandaba API Gateway
        IdDoc: { TipoDTE: input.tipo, Folio: 1, ...(input.fecha ? { FchEmis: input.fecha } : {}) },
        Emisor: { RUTEmisor: c.emisorRut, CdgSIISucur: sucursal },
        Receptor: {
          RUTRecep: input.receptorRut,
          RznSocRecep: cut(input.receptorNombre, 100),
          ...(input.receptorDireccion ? { DirRecep: cut(input.receptorDireccion, 70) } : {}),
          ...(input.receptorComuna ? { CmnaRecep: cut(input.receptorComuna, 20) } : {}),
        },
      },
      Detalle: [{ NmbItem: cut(input.item, 80), QtyItem: 1, PrcItem: Math.round(input.total) }],
      Meta: { info_emisor: info, plataforma: 'eboleta_web' },
    };

    // Hasta aquí nada se envió: un error es seguro (no se emitió)
    await this.session();
    let res: Response;
    try {
      // La página lo manda como JSON con este Content-Type
      res = await this.call('POST', '/dte/documentos/generar', dte, { timeoutMs: 90000, contentType: 'application/x-www-form-urlencoded' });
    } catch (err) {
      throw new SiiUnknownError(`Sin respuesta de Boleta electrónica: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`eBoleta directo ${res.status}: ${text.slice(0, 300)}`);
      if (res.status >= 400 && res.status < 500) throw new SiiRejectedError(`El SII rechazó la boleta: ${text.replace(/^"|"$/g, '').slice(0, 300)}`);
      throw new SiiUnknownError(`Boleta electrónica respondió ${res.status}: ${text.slice(0, 200)}`);
    }
    let data: { folio?: number | string; dte?: number; pdf_public_url?: string; b64encoded_pdf?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new SiiUnknownError('Boleta electrónica respondió algo que no se entiende: revisa en el SII si quedó emitida');
    }
    const folio = Number(data.folio);
    if (!Number.isFinite(folio) || folio <= 0) throw new SiiUnknownError('Boleta electrónica no devolvió el folio: revisa en el SII si quedó emitida');
    return {
      folio,
      dte: Number(data.dte ?? input.tipo),
      pdfUrl: data.pdf_public_url ?? null,
      pdfBase64: data.b64encoded_pdf ? data.b64encoded_pdf.replace(/^data:[^,]*,/, '') : null,
      raw: { provider: 'SII_DIRECTO', folio, dte: data.dte, pdf: data.pdf_public_url ?? null },
    };
  }

  /** Prueba: entra al SII y lee la empresa (no emite nada) */
  async test(): Promise<string> {
    const e = await this.emisor(true);
    const docs = (e.tiposDte ?? []).map((t) => t.codigo).join(', ');
    return `Conectado directo con Boleta electrónica del SII: ${e.razonSocial}, ${e.sucursales?.length ?? 0} sucursal(es), documentos ${docs || 'ninguno'}.`;
  }
}
