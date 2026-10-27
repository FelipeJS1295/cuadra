import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../../company/settings.service.js';
import { SiiRejectedError, SiiUnknownError } from '../api-gateway.client.js';
import type { SalesSummaryRow } from './types.js';

/**
 * SimpleAPI (https://www.simpleapi.cl) · producto SimpleAPI-RCV.
 *
 * Lee el Registro de Compras y Ventas del SII con el RUT y la clave del SII de la persona
 * autorizada (variante "Clave SII"):
 *   POST {url}/RCVEmpresas/compras/{mes}/{anio}
 *   POST {url}/RCVEmpresas/ventas/{mes}/{anio}
 *   multipart/form-data, campo "input" = { RutEmpresa, RutUsuario, PasswordSII, Ambiente, Detallado }
 *   Authorization: Basic base64("api:" + API_KEY)
 * Respuesta: { Caratula, Compras: { Resumenes, DetalleCompras }, Ventas: { Resumenes, DetalleVentas } }
 *
 * Cada bloque de hasta 5.000 documentos cuenta como 1 petición del plan; un mes sin documentos no cuenta.
 */

/** Busca una propiedad sin importar mayúsculas (la API puede responder PascalCase o camelCase) */
function prop(obj: unknown, ...names: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const entries = Object.entries(obj as Record<string, unknown>);
  for (const name of names) {
    const hit = entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (hit && hit[1] !== undefined && hit[1] !== null) return hit[1];
  }
  return undefined;
}

const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** Estado en el RCV de una compra de SimpleAPI → REGISTRO / PENDIENTE (las reclamadas no se traen) */
function rcvStatus(row: Record<string, unknown>): 'REGISTRO' | 'PENDIENTE' | null {
  const estado = String(prop(row, 'Estado') ?? '').toLowerCase();
  if (estado.includes('pendiente')) return 'PENDIENTE';
  if (estado.includes('reclam') || estado.includes('no incluir')) return null;
  return 'REGISTRO';
}

@Injectable()
export class SimpleApiClient {
  private readonly logger = new Logger(SimpleApiClient.name);
  /** El mismo mes se pide una vez aunque se lean "registro" y "pendientes" por separado */
  private cache = new Map<string, { at: number; data: Promise<unknown> }>();

  constructor(private readonly settings: SettingsService) {}

  private async credentials() {
    const s = await this.settings.sii();
    const missing = this.settings.siiMissing({ ...s, provider: 'SIMPLEAPI' });
    if (missing.length) {
      throw new ServiceUnavailableException(`La conexión con SimpleAPI no está configurada. Falta: ${missing.join(', ')} (Configuración → SII)`);
    }
    return { url: s.simpleapiUrl, key: s.simpleapiKey!, rut: s.emisorRut!, userRut: s.usuarioRut!, clave: s.clave!, tenantId: this.settings.tenantId() };
  }

  private async rcv(kind: 'compras' | 'ventas', periodo: string): Promise<unknown> {
    const c = await this.credentials();
    const anio = periodo.slice(0, 4);
    const mes = String(Number(periodo.slice(4, 6)));
    const cacheKey = `${c.tenantId}:${kind}:${periodo}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

    const form = new FormData();
    form.append(
      'input',
      JSON.stringify({ RutEmpresa: c.rut, RutUsuario: c.userRut, PasswordSII: c.clave, Ambiente: 1, Detallado: true, ProcesaBoletas: false }),
    );
    const request = (async () => {
      let res: Response;
      try {
        res = await fetch(`${c.url}/RCVEmpresas/${kind}/${mes}/${anio}`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`api:${c.key}`).toString('base64')}`, Accept: 'application/json' },
          body: form,
          // El SII puede tardar: SimpleAPI consulta el portal por dentro
          signal: AbortSignal.timeout(180000),
        });
      } catch (err) {
        throw new SiiUnknownError(`Sin respuesta de SimpleAPI: ${(err as Error).message}`);
      }
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 300);
        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          message = String(prop(json, 'message', 'mensaje', 'error', 'title') ?? message);
        } catch {
          /* no es JSON */
        }
        this.logger.warn(`SimpleAPI ${kind} ${periodo} ${res.status}: ${message}`);
        if (res.status === 401 || res.status === 403) throw new SiiRejectedError(`SimpleAPI rechazó la API Key (${res.status}): ${message}`);
        if (res.status >= 500) throw new SiiUnknownError(`SimpleAPI respondió ${res.status}: ${message}`);
        throw new SiiRejectedError(message || `Error ${res.status}`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SiiUnknownError('SimpleAPI no respondió JSON');
      }
    })();
    this.cache.set(cacheKey, { at: Date.now(), data: request });
    request.catch(() => this.cache.delete(cacheKey));
    return request;
  }

  /**
   * Compras del mes con los mismos nombres de campo que entiende el importador
   * (tipodte, rutproveedor, razonsocial, folio, fechaemision, montoneto…).
   */
  async comprasRcv(periodo: string, estado: 'REGISTRO' | 'PENDIENTE'): Promise<Record<string, unknown>[]> {
    const body = await this.rcv('compras', periodo);
    const rows = list(prop(prop(body, 'Compras'), 'DetalleCompras'));
    return rows
      .filter((r) => rcvStatus(r) === estado)
      .map((r) => ({
        tipodte: prop(r, 'TipoDTE'),
        rutproveedor: prop(r, 'RutProveedor'),
        razonsocial: prop(r, 'RazonSocial'),
        folio: prop(r, 'Folio'),
        fechaemision: prop(r, 'FechaEmision'),
        fecharecepcion: prop(r, 'FechaRecepcion'),
        montoexento: prop(r, 'MontoExento') ?? 0,
        montoneto: prop(r, 'MontoNeto') ?? 0,
        montoivarecuperable: prop(r, 'MontoIvaRecuperable') ?? 0,
        montototal: prop(r, 'MontoTotal') ?? 0,
        estadosii: prop(r, 'Estado'),
        origen: 'SIMPLEAPI',
      }));
  }

  /** Resumen del Registro de Ventas por tipo de documento */
  async ventasResumen(periodo: string): Promise<SalesSummaryRow[]> {
    const body = await this.rcv('ventas', periodo);
    return list(prop(prop(body, 'Ventas'), 'Resumenes'))
      .map((r) => ({
        tipodoc: Number(prop(r, 'TipoDte', 'TipoDTE')),
        nombretipodoc: String(prop(r, 'TipoDteString') ?? `Tipo ${prop(r, 'TipoDte', 'TipoDTE')}`),
        totaldocumentos: Number(prop(r, 'TotalDocumentos') ?? 0),
        montototal: Number(prop(r, 'MontoTotal') ?? 0),
        montoiva: Number(prop(r, 'IvaRecuperable') ?? 0) + Number(prop(r, 'IvaNoRecuperable') ?? 0),
      }))
      .filter((r) => r.tipodoc > 0);
  }

  /** Prueba la conexión leyendo el resumen de ventas del mes actual */
  async test(): Promise<string> {
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const rows = await this.ventasResumen(now.slice(0, 7).replace('-', ''));
    const docs = rows.reduce((n, r) => n + r.totaldocumentos, 0);
    return `Conectado con SimpleAPI. Registro de Ventas de este mes: ${docs} documento${docs === 1 ? '' : 's'}.`;
  }
}
