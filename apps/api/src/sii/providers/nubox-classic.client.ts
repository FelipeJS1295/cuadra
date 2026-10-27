import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../../company/settings.service.js';
import { SiiRejectedError, SiiUnknownError } from '../api-gateway.client.js';
import { territory } from './nubox.client.js';
import type { IssuedDoc } from './types.js';

/**
 * Nubox · API "clásica" de Factura Electrónica (la del "Usuario API" que se crea en Nubox
 * con usuario y contraseña; para planes sin acceso a la API de Integraciones).
 * Docs: https://developers.nubox.com/autenticacion · /emision-venta · /pdf-venta
 *
 *   POST {url}/autenticar                       Authorization: Basic base64(usuario:contraseña)
 *        → token en el header "Token" (dura 15 min sin uso) y los sistemas del usuario (con su N° de serie)
 *   POST {url}/factura/documento/{rut}/{serie}/{rutFuncionario}/{foliosAutomaticos}/{39|41}/dte/extendido
 *        BOLETAS (developers.nubox.com/emision-boleta-info)   body { productos: [...], documentoReferenciado: {} }
 *   POST {url}/factura/documento/{rut}/{serie}/rutFuncionario/{foliosAutomaticos}/emitir/ventaExtendido
 *        ?rutFuncionario={rut persona}&emitir=true      FACTURAS Y NOTAS (developers.nubox.com/emision-venta)
 *   GET  {url}/factura/documento/{rut}/{serie}/{folio}/{tipo}/pdf     tipo: BOL-EL, N%2FC-EL…
 *
 * La documentación no dice cómo se llama el header del token en las llamadas siguientes ni qué
 * responde la emisión: se manda "Token" y se busca el folio en la respuesta.
 */

const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Busca un valor por nombre de campo (sin importar mayúsculas), en cualquier nivel del JSON */
function findDeep(obj: unknown, re: RegExp, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findDeep(v, re, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (re.test(k) && v !== null && v !== '' && typeof v !== 'object') return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = findDeep(v, re, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Abreviatura de Nubox para cada tipo de documento (para el PDF) */
const ABBR: Record<number, string> = { 33: 'FAC-EL', 34: 'FAC-EE', 39: 'BOL-EL', 41: 'BOL-EE', 56: 'N/D-EL', 61: 'N/C-EL' };



export interface ClassicInvoiceInput {
  receptorRut: string;
  receptorNombre: string;
  receptorGiro: string;
  receptorDireccion: string;
  receptorComuna: string;
  receptorEmail?: string | null;
  item: string;
  /** Total con IVA */
  total: number;
  fecha: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClassicDocInput {
  tipo: 39 | 61;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  receptorDireccion?: string | null;
  receptorComuna?: string | null;
  receptorGiro?: string | null;
  item: string;
  /** Total con IVA */
  total: number;
  referencia?: { tipo: number; folio: string; fecha: string; codRef: 1 | 3; razon: string };
}

@Injectable()
export class NuboxClassicClient {
  private readonly logger = new Logger(NuboxClassicClient.name);
  private tokens = new Map<string, { token: string; serie: string; at: number }>();

  constructor(private readonly settings: SettingsService) {}

  private async config() {
    const s = await this.settings.sii();
    const missing = this.settings.siiMissing({ ...s, provider: 'NUBOX_CLASICO' });
    if (missing.length) {
      throw new ServiceUnavailableException(`La conexión con Nubox no está configurada. Falta: ${missing.join(', ')} (Configuración → SII)`);
    }
    return {
      url: s.nuboxClassicUrl,
      user: s.nuboxUser!,
      password: s.nuboxPassword!,
      rut: s.emisorRut!,
      funcionario: s.usuarioRut!,
      sucursal: s.sucursal || '1',
      serie: s.nuboxSerie,
      // Las facturas van por la API de Nubox Pyme, con el mismo token del usuario API
      pymeUrl: `${s.nuboxUrl}/v1`,
      tenantId: this.settings.tenantId(),
    };
  }

  private async fetch(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60000) });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new SiiRejectedError(`No se pudo conectar con Nubox (${code})`);
      throw new SiiUnknownError(`Sin respuesta de Nubox: ${(err as Error).message}`);
    }
  }

  private async message(res: Response) {
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text) as unknown;
      const msg = findDeep(json, /^(message|mensaje|error|errores|detalle|descripcion)$/i);
      if (msg) return String(msg);
    } catch {
      /* no es JSON */
    }
    if (res.status === 401 || res.status === 403) return `Nubox rechazó el usuario o la contraseña (${res.status})`;
    return text.replace(/\s+/g, ' ').slice(0, 300) || `Error ${res.status}`;
  }

  /** Entra con el usuario API: devuelve el token y el N° de serie del sistema de factura */
  async login(force = false) {
    const c = await this.config();
    const cached = this.tokens.get(c.tenantId);
    if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return { ...c, token: cached.token, serie: cached.serie };
    const res = await this.fetch(`${c.url}/autenticar`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}`, Accept: 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new SiiRejectedError(await this.message(res));
    const token = res.headers.get('token') ?? res.headers.get('Token');
    const text = await res.text().catch(() => '');
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    if (!token) throw new SiiUnknownError('Nubox no entregó el token al entrar');
    // El N° de serie viene en la lista de sistemas del usuario (el nombre exacto del campo no está documentado)
    const serie = c.serie || String(findDeep(body, /^(numero_?serie|num_?serie|nro_?serie|serie|n_?serie)$/i) ?? findDeep(body, /serie/i) ?? '');
    if (!serie) {
      const shown = (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 600) || '(vacío)';
      this.logger.warn(`Nubox autenticar sin N° de serie. Respuesta: ${shown}`);
      throw new SiiRejectedError(
        `Nubox aceptó el usuario, pero no encontramos el N° de serie del sistema en su respuesta. ` +
          `Escríbelo en Configuración → SII. Lo que respondió Nubox: ${shown}`,
      );
    }
    this.tokens.set(c.tenantId, { token, serie, at: Date.now() });
    return { ...c, token, serie, systems: body };
  }

  private headers(token: string) {
    // El header del token no está documentado: se manda con los nombres que usa Nubox en sus ejemplos
    return { Token: token, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  /** Emite una boleta (39) o nota de crédito (61) con folio automático */
  async emitir(input: ClassicDocInput): Promise<IssuedDoc> {
    const c = await this.login();
    const total = Math.round(input.total);
    const boleta = input.tipo === 39;
    const counterpart = {
      rutContraparte: input.receptorRut,
      razonSocialContraparte: cut(input.receptorNombre || 'Cliente', 100),
      giroContraparte: cut(input.receptorGiro || 'Particular', 40),
      comunaContraparte: cut(input.receptorComuna || 'Santiago', 20),
      ...(input.receptorDireccion ? { direccionContraparte: cut(input.receptorDireccion, 70) } : {}),
    };
    const amounts = {
      producto: cut(input.item, 80),
      descripcion: cut(input.item, 80),
      cantidad: 1,
      // Boletas y sus notas de crédito van con el precio final, IVA incluido
      precio: total,
      valor: total,
      unidadMedida: 'UN',
      afecto: 'SI',
      secuencia: 1,
    };
    // Las boletas tienen su propio endpoint en Nubox (con fechaEmision y tipo de servicio);
    // mandarlas por el de facturas (ventaExtendido) hace que Nubox responda 500
    // Fechas de la boleta con hora y zona (así las acepta Nubox en una integración que ya funciona)
    const day = `${input.fecha}T00:00:00.000-04:00`;
    // Boleta: mismos campos y en el mismo orden que la integración en Python que ya emite en Nubox
    const line = boleta
      ? {
          fechaEmision: day,
          folio: 1,
          rutContraparte: input.receptorRut || '66666666-6',
          razonSocialContraparte: cut(input.receptorNombre || 'Cliente Generico', 100),
          giroContraparte: cut(input.receptorGiro || 'Sin Giro', 40),
          comunaContraparte: cut(input.receptorComuna || 'Santiago', 20),
          direccionContraparte: cut(input.receptorDireccion || 'Sin Direccion', 70),
          codigoSucursal: c.sucursal,
          secuencia: 1,
          afecto: 'SI',
          producto: cut(input.item, 80),
          cantidad: 1,
          precio: total,
          valor: total,
          fechaVencimiento: day,
          // 3 = boleta de ventas y servicios
          codigoSIITipoDeServicio: '3',
          fechaPeriodoDesde: day,
          fechaPeriodoHasta: day,
        }
      : {
          ...counterpart,
          ...amounts,
          tipo: input.tipo,
          folio: 0,
          fecha: input.fecha,
          fechaEmision: input.fecha,
          fechaVencimiento: input.fecha,
          fechaPeriodoDesde: input.fecha,
          fechaPeriodoHasta: input.fecha,
          codigoSucursal: c.sucursal,
        };
    const r = input.referencia;
    const body = {
      productos: [line],
      // Nubox pide declararlo aunque vaya vacío
      documentoReferenciado: r
        ? {
            tipo: input.tipo,
            folio: 0,
            secuencia: 1,
            tipoDocumentoReferenciado: r.tipo,
            folioDocumentoReferenciado: Number(r.folio),
            fechaDocumentoReferenciado: Number(r.fecha.replace(/-/g, '')),
            motivoReferencia: r.codRef,
            glosa: cut(r.razon, 90),
          }
        : {},
    };
    const doc = `${c.url}/factura/documento/${encodeURIComponent(c.rut)}/${encodeURIComponent(c.serie)}`;
    const url = boleta
      ? `${doc}/${encodeURIComponent(c.funcionario)}/1/${input.tipo}/dte/extendido`
      : `${doc}/rutFuncionario/1/emitir/ventaExtendido?rutFuncionario=${encodeURIComponent(c.funcionario)}&emitir=true`;
    // Boleta: solo los headers que usa la integración que funciona (token y Content-Type)
    const headers = (token: string) => (boleta ? { token, 'Content-Type': 'application/json' } : this.headers(token));
    const path = url.replace(c.url, '');
    this.logger.log(`Nubox ${boleta ? 'boleta' : 'documento'}: enviando POST ${path} · ${JSON.stringify(body)}`);
    const started = Date.now();
    let res: Response;
    try {
      // Nubox puede tardar en responder mientras habla con el SII: se espera hasta 3 minutos
      res = await this.fetch(url, { method: 'POST', headers: headers(c.token), body: JSON.stringify(body), timeoutMs: 180000 });
      if (res.status === 401) {
        // Token vencido: se entra de nuevo una vez
        const again = await this.login(true);
        res = await this.fetch(url, { method: 'POST', headers: headers(again.token), body: JSON.stringify(body), timeoutMs: 180000 });
      }
    } catch (err) {
      this.logger.warn(`Nubox no respondió en ${Math.round((Date.now() - started) / 1000)} s: ${(err as Error).message}`);
      throw err;
    }
    this.logger.log(`Nubox respondió ${res.status} en ${Math.round((Date.now() - started) / 1000)} s`);
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => {
        try {
          return String(findDeep(JSON.parse(text), /^(message|mensaje|error|errores|detalle|descripcion)$/i) ?? text);
        } catch {
          return text;
        }
      })().replace(/\s+/g, ' ').slice(0, 400);
      // Lo enviado (sin claves) queda en el registro de la API, para revisarlo con Nubox
      this.logger.warn(`Nubox emisión ${res.status}: ${msg} · POST ${url.replace(c.url, '')} · ${JSON.stringify(body)}`);
      if (res.status >= 500) throw new SiiUnknownError(`Nubox respondió ${res.status}: ${msg}`);
      throw new SiiRejectedError(msg || `Error ${res.status}`);
    }
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* texto plano */
    }
    // El folio puede venir en el cuerpo (como campo o como número suelto) o en un header
    const folio = Number(
      findDeep(json, /^(folio|numeroFolio|folioDocumento)$/i) ??
        (typeof json === 'string' && /^\s*"?\d+"?\s*$/.test(json) ? json.replace(/\D/g, '') : null) ??
        res.headers.get('folio') ??
        NaN,
    );
    if (!Number.isFinite(folio) || folio <= 0) {
      this.logger.warn(`Nubox recibió el documento sin informar el folio. Respuesta: ${text.slice(0, 500) || '(vacía)'}`);
      throw new SiiUnknownError(
        `Nubox recibió el documento pero no informó su N° (respuesta: ${text.slice(0, 200) || 'vacía'}). Búscalo en Nubox y anótalo en la orden.`,
      );
    }
    // Nubox responde { Folio, UrlBoleta, MontoTotal, MontoNeto, TotalIVA, … }
    const pdfUrl = findDeep(json, /^(urlBoleta|urlDocumento|url)$/i);
    return {
      folio,
      dte: input.tipo,
      pdfUrl: typeof pdfUrl === 'string' && /^https?:\/\//.test(pdfUrl) ? pdfUrl : null,
      pdfBase64: null,
      raw: { provider: 'NUBOX_CLASICO', folio, tipo: input.tipo, response: json },
    };
  }

  /**
   * Factura electrónica (33) por la API de Nubox Pyme con el token del usuario API
   * (así funciona en otra integración de la empresa).
   *   POST {pyme}/v1/sales/issuance   header "token"   body [ { type: { legalCode: '33' }, client, details, … } ]
   * Responde el id de la venta (o su folio); el folio se consulta en GET {pyme}/v1/sales/{id}.
   */
  async emitirFactura(input: ClassicInvoiceInput): Promise<IssuedDoc> {
    const c = await this.login();
    const total = Math.round(input.total);
    // Nubox recibe el precio neto y calcula el IVA
    const net = Math.round(total / 1.19);
    const doc = {
      sequence: 1,
      type: { legalCode: '33' },
      client: {
        tradeName: cut(input.receptorNombre, 100),
        identification: { type: 1, value: input.receptorRut },
        email: input.receptorEmail ?? '',
        contactName: cut(input.receptorNombre, 100),
        mainActivity: cut(input.receptorGiro, 40),
        address: cut(input.receptorDireccion, 70),
        city: cut(input.receptorComuna, 20),
        // Si la comuna no se reconoce, Santiago (como la integración que ya funciona)
        territorialDivisionLegalCode: '13',
        territorialDivisionL2LegalCode: '13101',
        ...territory(input.receptorComuna),
      },
      dueDate: input.fecha,
      saleType: { id: 1 },
      paymentForm: { id: 1 },
      comment: 'Venta marketplace',
      details: [
        {
          order: 1,
          quantity: 1,
          productDescription: cut(input.item, 80),
          productDescriptionExtended: cut(input.item, 80),
          subjectToTax: true,
          uom: { code: 'UNID' },
          price: net,
          taxes: [],
          discountsAndSurcharges: [],
        },
      ],
      references: [],
    };
    const post = (token: string) =>
      this.fetch(`${c.pymeUrl}/sales/issuance`, {
        method: 'POST',
        headers: { token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify([doc]),
        timeoutMs: 120000,
      });
    let res = await post(c.token);
    if (res.status === 401) res = await post((await this.login(true)).token);
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* texto */
    }
    const item = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | null;
    const errors = (item?.errors as { field?: string; message?: string }[] | null | undefined) ?? null;
    if (errors?.length) throw new SiiRejectedError(`Nubox: ${errors.map((e) => [e.field, e.message].filter(Boolean).join(': ')).join(' · ')}`);
    if (!res.ok && res.status !== 207) {
      const msg = String(findDeep(json, /^(message|mensaje|error|detail|descripcion)$/i) ?? text).replace(/\s+/g, ' ').slice(0, 400);
      this.logger.warn(`Nubox factura ${res.status}: ${msg} · ${JSON.stringify(doc)}`);
      if (res.status >= 500) throw new SiiUnknownError(`Nubox respondió ${res.status}: ${msg}`);
      throw new SiiRejectedError(msg || `Error ${res.status}`);
    }
    const raw = (folio: number, extra: Record<string, unknown>) => ({ provider: 'NUBOX_CLASICO', folio, tipo: 33, ...extra });
    const direct = Number(findDeep(item, /^(documentNumber|folio|number)$/i));
    const id = item?.id as number | string | undefined;
    if (Number.isFinite(direct) && direct > 0) {
      return { folio: direct, dte: 33, pdfUrl: null, pdfBase64: null, raw: raw(direct, { nuboxId: id ?? null, response: json }) };
    }
    if (!id) throw new SiiUnknownError(`Nubox recibió la factura pero no informó su N° (respuesta: ${text.slice(0, 200) || 'vacía'}). Búscala en Nubox y anótala en la orden.`);
    // El folio queda listo unos segundos después
    for (let i = 0; i < 10; i++) {
      await sleep(i === 0 ? 1500 : 2500);
      const r = await this.fetch(`${c.pymeUrl}/sales/${encodeURIComponent(String(id))}`, { headers: { token: c.token, Accept: 'application/json' } }).catch(() => null);
      if (!r?.ok) continue;
      const sale = (await r.json().catch(() => null)) as { number?: string | number; emissionStatus?: { id?: number; name?: string }; comments?: string } | null;
      const status = `${sale?.emissionStatus?.name ?? ''} ${sale?.comments ?? ''}`.toLowerCase();
      if (/rechaz|error/.test(status)) throw new SiiRejectedError(`Nubox no pudo emitir la factura: ${sale?.comments ?? sale?.emissionStatus?.name}`);
      const folio = Number(sale?.number);
      if (Number.isFinite(folio) && folio > 0 && (sale?.emissionStatus?.id === undefined || sale.emissionStatus.id === 1)) {
        return { folio, dte: 33, pdfUrl: null, pdfBase64: null, raw: raw(folio, { nuboxId: id, sale }) };
      }
    }
    throw new SiiUnknownError(`Nubox recibió la factura (id ${id}) pero todavía no entrega el folio. Revísala en Nubox en unos minutos y anota su N° en la orden.`);
  }

  /** PDF de un documento emitido */
  async pdf(folio: number, tipo: number): Promise<Buffer> {
    const c = await this.login();
    const abbr = encodeURIComponent(ABBR[tipo] ?? 'BOL-EL');
    const url = `${c.url}/factura/documento/${encodeURIComponent(c.rut)}/${encodeURIComponent(c.serie)}/${folio}/${abbr}/pdf`;
    let res = await this.fetch(url, { headers: { Token: c.token } });
    if (res.status === 401) res = await this.fetch(url, { headers: { Token: (await this.login(true)).token } });
    if (!res.ok) throw new SiiRejectedError(`No se pudo obtener el PDF de Nubox: ${await this.message(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async test(): Promise<string> {
    const r = await this.login(true);
    return `Conectado con Nubox (usuario API). Sistema de factura N° de serie ${r.serie}.`;
  }
}
