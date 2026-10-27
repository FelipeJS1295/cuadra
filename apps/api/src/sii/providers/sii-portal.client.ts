import { randomUUID } from 'node:crypto';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../../company/settings.service.js';
import { SiiRejectedError, SiiUnknownError } from '../api-gateway.client.js';
import type { SalesSummaryRow } from './types.js';

/**
 * Conexión DIRECTA con el portal del SII, con el RUT y la clave tributaria de una persona
 * autorizada de la empresa (sin certificado digital y sin servicios pagados).
 *
 *   1. POST zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi   rut, dv, rutcntr, clave, referencia   → cookie TOKEN
 *   2. GET  www4.sii.cl/consemitidosinternetui/        abre la sesión de "Consulta de documentos"
 *   3. POST www4.sii.cl/consemitidosinternetui/services/data/facadeService/getResumen
 *        { rutContribuyente, dvContribuyente, periodo: 'AAAA-MM', operacion: 2 = recibidos }
 *   4. POST .../getDetalleRecibidos   { tipoDoc, rut, dv, periodo, operacion: 2, derrCodigo, refNCD: '0' }
 *        → cada factura recibida (folio, fecha, emisor, montos). No pide captcha.
 *   5. POST www4.sii.cl/consdcvinternetui/services/data/facadeService/getResumen
 *        { rutEmisor, dvEmisor, ptributario: 'AAAAMM', estadoContab: 'REGISTRO', operacion: 'VENTA' | 'COMPRA' }
 *        → totales oficiales del Registro de Compras y Ventas (incluye boletas)
 *
 * El detalle oficial del RCV (getDetalleCompra) pide reCAPTCHA: por eso las compras se leen
 * desde "Consulta de documentos recibidos", que trae lo mismo documento por documento.
 *
 * Para pruebas, los hosts se pueden cambiar con SII_PORTAL_LOGIN_URL y SII_PORTAL_HOST.
 */

const LOGIN_URL = process.env.SII_PORTAL_LOGIN_URL || 'https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi';
const HOST = (process.env.SII_PORTAL_HOST || 'https://www4.sii.cl').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

type Jar = Map<string, string>;

const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function keep(jar: Jar, res: Response) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value && !/^deleted$/i.test(value)) jar.set(name, value);
  }
}

/** "76.990.942-7" -> ["76990942", "7"] */
function split(rut: string): [string, string] {
  const clean = rut.replace(/\./g, '').toUpperCase();
  const [body, dv] = clean.includes('-') ? clean.split('-') : [clean.slice(0, -1), clean.slice(-1)];
  return [body, dv];
}

/** Valor por nombre de campo (sin importar mayúsculas ni guiones bajos) */
function val(o: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(o)) if (re.test(k.replace(/_/g, '')) && v !== null && v !== '' && typeof v !== 'object') return v;
  return undefined;
}
const money = (v: unknown) => (v === undefined ? 0 : Number(String(v).replace(/[^\d.-]/g, '')) || 0);

/** Un documento recibido del SII -> fila con los nombres del Registro de Compras */
function purchaseRow(d: Record<string, unknown>, tipo: number): Record<string, unknown> | null {
  // En "recibidos", rutReceptor / dvReceptor son el RUT del EMISOR (el proveedor)
  const rutBody = val(d, /^(rutreceptor|rutemisor|rutcontraparte|rutdoc|rutproveedor|rut)$/i);
  const dv = val(d, /^(dvreceptor|dvemisor|dvcontraparte|dvdoc|dvproveedor|dv)$/i);
  const folio = val(d, /^(folio|nrodoc|numerodocumento|numdoc|folioDoc)$/i);
  if (rutBody === undefined || folio === undefined) return null;
  const rut = String(rutBody).includes('-') || dv === undefined ? String(rutBody) : `${rutBody}-${dv}`;
  return {
    tipodte: Number(val(d, /^(tipodoc|tipodte|tipodocumento)$/i)) || tipo,
    rutproveedor: rut,
    razonsocial: String(val(d, /^(razonsocial|rznsoc|nombrereceptor|nombreemisor|nombre|razonsocialreceptor|razonsocialemisor)$/i) ?? rut),
    folio: String(folio),
    fechaemision: val(d, /^(fechaemision|fchemis|fchdoc|fechadoc|fecha|fechaemisiondoc)$/i) ?? null,
    fecharecepcion: val(d, /^(fecharecepcion|fchrecepcion)$/i) ?? null,
    montoexento: money(val(d, /^(montoexento|mntexe|mntexento)$/i)),
    montoneto: money(val(d, /^(montoneto|mntneto)$/i)),
    montoiva: money(val(d, /^(montoiva|mntiva|iva|montoivarecuperable)$/i)),
    montototal: money(val(d, /^(montototal|mnttotal|total)$/i)),
    origen: 'SII',
    sii: d,
  };
}

interface Session {
  jar: Jar;
  token: string;
  at: number;
}

@Injectable()
export class SiiPortalClient {
  private readonly logger = new Logger(SiiPortalClient.name);
  private sessions = new Map<string, Session>();
  private cache = new Map<string, { at: number; rows: Record<string, unknown>[] }>();

  constructor(private readonly settings: SettingsService) {}

  /** ¿La empresa dejó su RUT y clave del SII? */
  static ready(s: { emisorRut: string | null; usuarioRut: string | null; clave: string | null }) {
    return Boolean(s.emisorRut && s.usuarioRut && s.clave);
  }

  private async config() {
    const s = await this.settings.sii();
    if (!SiiPortalClient.ready(s)) {
      throw new ServiceUnavailableException('Para leer el SII directo falta tu RUT y tu clave del SII (Configuración → SII)');
    }
    return { emisor: s.emisorRut!, usuario: s.usuarioRut!, clave: s.clave!, tenantId: this.settings.tenantId() };
  }

  private async fetch(url: string, jar: Jar, init: RequestInit = {}, timeoutMs = 60000) {
    let current = url;
    let method = init.method ?? 'GET';
    let body = init.body;
    // Las redirecciones se siguen a mano para guardar las cookies de cada paso
    for (let hop = 0; hop < 8; hop++) {
      let res: Response;
      try {
        res = await fetch(current, {
          ...init,
          method,
          body,
          redirect: 'manual',
          headers: { 'User-Agent': UA, ...(init.headers as Record<string, string>), Cookie: cookieHeader(jar) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
        if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new SiiRejectedError(`No se pudo conectar con el SII (${code})`);
        throw new SiiUnknownError(`El SII no respondió: ${(err as Error).message}`);
      }
      keep(jar, res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      return { status: res.status, text: await res.text() };
    }
    throw new SiiUnknownError('El SII redirigió demasiadas veces');
  }

  /** Entra al SII con RUT y clave. La sesión se reutiliza unos minutos */
  private async login(force = false): Promise<Session & { emisor: string }> {
    const c = await this.config();
    const key = `${c.tenantId}:${c.usuario}`;
    const cached = this.sessions.get(key);
    if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return { ...cached, emisor: c.emisor };
    const [rut, dv] = split(c.usuario);
    const jar: Jar = new Map();
    const form = new URLSearchParams({
      rut,
      dv,
      referencia: 'https://misiir.sii.cl/cgi_misii/siihome.cgi',
      '411': '',
      rutcntr: `${Number(rut).toLocaleString('es-CL')}-${dv}`,
      clave: c.clave,
    });
    const res = await this.fetch(LOGIN_URL, jar, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html' },
      body: form.toString(),
    });
    const token = jar.get('TOKEN');
    if (!token) {
      const text = res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      if (/superado el m[aá]ximo|demasiadas sesiones/i.test(text)) {
        throw new SiiRejectedError('El SII dice que hay demasiadas sesiones abiertas con tu RUT: cierra sesión en el SII (o espera unos minutos) y vuelve a intentar');
      }
      if (/clave.*(incorrect|inv[aá]lid|bloquead)|rut.*(incorrect|inv[aá]lid)|no coincide/i.test(text)) {
        throw new SiiRejectedError('El SII rechazó el RUT o la clave. Revísalos en Configuración → SII');
      }
      if (/cambiar clave|actualizar.*clave/i.test(text)) {
        throw new SiiRejectedError('El SII pide cambiar o actualizar tu clave: entra a sii.cl, hazlo y vuelve a intentar');
      }
      this.logger.warn(`SII login sin TOKEN (${res.status}): ${text.slice(0, 300)}`);
      throw new SiiRejectedError(`El SII no aceptó el ingreso. Respuesta: ${text.slice(0, 200) || res.status}`);
    }
    // Abre la sesión de la consulta de documentos (y la del Registro de Compras y Ventas)
    await this.fetch(`${HOST}/consemitidosinternetui/`, jar);
    await this.fetch(`${HOST}/consdcvinternetui/`, jar).catch(() => undefined);
    const session = { jar, token: jar.get('TOKEN') ?? token, at: Date.now() };
    this.sessions.set(key, session);
    return { ...session, emisor: c.emisor };
  }

  private async call(app: 'consemitidosinternetui' | 'consdcvinternetui', method: string, data: unknown) {
    const ns = app === 'consemitidosinternetui' ? 'cl.sii.sdi.lob.diii.consemitidos.data.api.interfaces.FacadeService' : 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';
    const send = async (s: Session) => {
      const body = JSON.stringify({ metaData: { namespace: `${ns}/${method}`, conversationId: s.token, transactionId: randomUUID(), page: null }, data });
      return this.fetch(`${HOST}/${app}/services/data/facadeService/${method}`, s.jar, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Origin: HOST,
          Referer: `${HOST}/${app}/`,
        },
        body,
      });
    };
    let s = await this.login();
    let res = await send(s);
    // Sesión vencida: el SII responde la página de login (HTML) o 401/403
    if (res.status === 401 || res.status === 403 || /^\s*</.test(res.text)) {
      s = await this.login(true);
      res = await send(s);
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      throw new SiiUnknownError(`El SII respondió algo inesperado (${res.status}): ${res.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const estado = (json.respEstado ?? json.respEstadoResp) as { codRespuesta?: number; msgeRespuesta?: string } | undefined;
    if (res.status >= 400 || (estado && estado.codRespuesta !== undefined && estado.codRespuesta !== 0)) {
      const msg = estado?.msgeRespuesta ?? res.text.slice(0, 200);
      // "Sin información" no es un error
      if (/no (existe|hay|se encontr)|sin (datos|informaci|registros)/i.test(String(msg))) return { ...json, data: [] };
      throw new SiiRejectedError(`El SII respondió: ${msg}`);
    }
    return json;
  }

  /** Facturas recibidas de un mes (AAAAMM), con los nombres de columnas del Registro de Compras */
  async compras(periodo: string): Promise<Record<string, unknown>[]> {
    const c = await this.config();
    const key = `${c.tenantId}:${periodo}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rows;
    const [rut, dv] = split(c.emisor);
    const p = `${periodo.slice(0, 4)}-${periodo.slice(4, 6)}`;
    const resumen = await this.call('consemitidosinternetui', 'getResumen', { periodo: p, rutContribuyente: rut, dvContribuyente: dv, operacion: 2 });
    const tipos = ((resumen.data as { resumenDte?: { tipoDoc: number }[] } | undefined)?.resumenDte ?? []).map((t) => Number(t.tipoDoc)).filter(Boolean);
    const rows: Record<string, unknown>[] = [];
    let unknown: string | null = null;
    for (const tipo of tipos) {
      const r = await this.call('consemitidosinternetui', 'getDetalleRecibidos', {
        tipoDoc: String(tipo),
        rut,
        dv,
        periodo: p,
        operacion: 2,
        derrCodigo: String(tipo),
        refNCD: '0',
      });
      const items = ((r.dataResp as { detalles?: Record<string, unknown>[] } | undefined)?.detalles ?? (Array.isArray(r.data) ? r.data : [])) as Record<string, unknown>[];
      for (const d of items) {
        const row = purchaseRow(d, tipo);
        if (row) rows.push(row);
        else unknown ??= JSON.stringify(d).slice(0, 400);
      }
    }
    this.logger.log(`SII compras ${periodo}: ${rows.length} documentos (tipos ${tipos.join(', ') || 'ninguno'})`);
    if (!rows.length && unknown) {
      this.logger.warn(`SII compras: documento no reconocido: ${unknown}`);
      throw new SiiRejectedError(`El SII respondió, pero Cuadra no reconoce el formato de los documentos. Ejemplo: ${unknown}`);
    }
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  /** Totales del Registro de Compras y Ventas por tipo de documento (incluye boletas) */
  async resumen(periodo: string, operacion: 'VENTA' | 'COMPRA'): Promise<SalesSummaryRow[]> {
    const c = await this.config();
    const [rut, dv] = split(c.emisor);
    const r = await this.call('consdcvinternetui', 'getResumen', {
      rutEmisor: rut,
      dvEmisor: dv,
      ptributario: periodo,
      estadoContab: 'REGISTRO',
      operacion,
      busquedaInicial: true,
    });
    const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
    return rows
      .map((x) => {
        const type = Number(val(x, /^(rsmntipodocinteger|rsmntipodoc|tipodoc)$/i));
        return {
          tipodoc: type,
          nombretipodoc: String(val(x, /^(dcvnombretipodoc|nombretipodoc)$/i) ?? `Tipo ${type}`),
          totaldocumentos: money(val(x, /^(rsmntotdoc|totaldocumentos)$/i)),
          montototal: money(val(x, /^(rsmnmnttotal|montototal)$/i)),
          montoiva: money(val(x, /^(rsmnmntiva|montoiva)$/i)),
        };
      })
      .filter((x) => x.tipodoc > 0);
  }

  async test(): Promise<string> {
    await this.login(true);
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const rows = await this.compras(now.slice(0, 7).replace('-', ''));
    return `Entramos al SII con tu RUT y clave. Facturas recibidas este mes: ${rows.length}.`;
  }
}
