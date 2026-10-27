import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../company/settings.service.js';
import { PROVIDER_NAMES } from './providers/types.js';

/**
 * Cliente de API Gateway (https://www.apigateway.cl) para el SII.
 *
 * Variables del .env:
 *   APIGATEWAY_TOKEN   token de la "conexión" creada en API Gateway
 *   SII_EMISOR_RUT     RUT de la EMPRESA que emite la boleta (ej: 76123456-7)
 *   SII_USUARIO_RUT    RUT de la PERSONA que entra al SII (la misma con que haces las boletas a mano)
 *   SII_USUARIO_CLAVE  clave del SII de esa persona
 *   APIGATEWAY_URL     (opcional) por defecto https://app.apigateway.cl/api/v2
 *
 * Igual que en el portal: se entra con el RUT y clave personales y se emite a nombre de la empresa
 * (la persona debe estar autorizada como usuario de eBoleta de la empresa).
 * Si la empresa tiene clave propia, SII_USUARIO_RUT puede ser el mismo RUT de la empresa.
 * Las credenciales van en cada llamada (API Gateway no las guarda).
 */

/** Recorta un texto al largo máximo que acepta el SII */
const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** El SII/API Gateway respondió con un error claro: la boleta NO se emitió */
export class SiiRejectedError extends Error {}

/** No se sabe si se emitió (se cortó la conexión, timeout, error 5xx) */
export class SiiUnknownError extends Error {}

export interface EboletaResult {
  folio: number;
  dte: number;
  pdfUrl: string | null;
  /** PDF en base64 (sin el prefijo "data:...;base64,") */
  pdfBase64: string | null;
  raw: unknown;
}

export interface EboletaInput {
  /** 39 afecta · 41 exenta */
  tipo: 39 | 41;
  /** RUT del cliente (o el genérico 66666666-6) */
  receptorRut: string;
  /** Nombre del cliente (obligatorio para el SII) */
  receptorNombre: string;
  /** Dirección y comuna (opcionales) */
  receptorDireccion?: string | null;
  receptorComuna?: string | null;
  /** Nombre del ítem (eBoleta admite un solo ítem por boleta) */
  item: string;
  /** Total con IVA */
  total: number;
  /** Fecha de emisión de la boleta (AAAA-MM-DD): la fecha de la orden */
  fecha: string;
}

/** Datos de la empresa en eBoleta (los mismos que tiene configurados en el portal) */
export interface EmisorInfo {
  contribuyente: Record<string, unknown>;
  sucursales: { codigo: number | string; direccion?: string | null; comuna?: string | null; [k: string]: unknown }[];
  usuarios: { user: string; nombre?: string; es_representante?: boolean; [k: string]: unknown }[];
}

@Injectable()
export class ApiGatewayClient {
  private readonly logger = new Logger(ApiGatewayClient.name);
  /** Datos del emisor (se piden una vez y se guardan 6 horas) */
  private emisorCache = new Map<string, { at: number; data: EmisorInfo }>();

  constructor(private readonly settings: SettingsService) {}

  /** ¿Está configurado para la empresa actual? (para mostrar u ocultar los botones) */
  async config() {
    const c = await this.settings.sii();
    return {
      /** Solo si la empresa eligió API Gateway como proveedor del SII */
      enabled: c.provider === 'APIGATEWAY' && Boolean(c.token && c.emisorRut && c.usuarioRut && c.clave),
      provider: c.provider,
      rut: c.emisorRut,
      userRut: c.usuarioRut,
      missing: [
        !c.token && 'Token de API Gateway',
        !c.emisorRut && 'RUT de la empresa',
        !c.usuarioRut && 'RUT de la persona que entra al SII',
        !c.clave && 'Clave del SII',
      ].filter(Boolean) as string[],
    };
  }

  private async credentials() {
    const c = await this.settings.sii();
    const cfg = await this.config();
    if (c.provider !== 'APIGATEWAY') {
      throw new ServiceUnavailableException(
        `Esto funciona solo con API Gateway y tu empresa se conecta al SII con ${PROVIDER_NAMES[c.provider]} (Configuración → SII)`,
      );
    }
    if (!cfg.enabled) {
      throw new ServiceUnavailableException(`La conexión con el SII no está configurada. Falta: ${cfg.missing.join(', ')} (Configuración → SII)`);
    }
    return {
      token: c.token!,
      /** RUT de la empresa (emisor) */
      rut: c.emisorRut!,
      /** RUT y clave de la persona que entra al SII */
      userRut: c.usuarioRut!,
      clave: c.clave!,
      url: c.apigatewayUrl,
      sucursal: c.sucursal,
      tenantId: this.settings.tenantId(),
    };
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs = 90000): Promise<Response> {
    const c = await this.credentials();
    try {
      return await fetch(`${c.url}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${c.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ auth: { pass: { rut: c.userRut, clave: c.clave } }, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No se alcanzó a conectar: seguro que no se emitió nada
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
        throw new SiiRejectedError(`No se pudo conectar con API Gateway (${code})`);
      }
      // Timeout o corte a medio camino: no se sabe si se emitió
      throw new SiiUnknownError(`Sin respuesta de API Gateway: ${(err as Error).message}`);
    }
  }

  /** Mensaje de error de la respuesta (API Gateway responde { message } o similar) */
  private async errorMessage(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const msg = json.message ?? json.error ?? json.detail ?? json.errors;
      if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
    } catch {
      /* no es JSON */
    }
    return text.slice(0, 300) || `Error ${res.status}`;
  }

  /** Datos de la empresa en eBoleta: razón social, giro, sucursales y usuarios autorizados */
  async emisor(refresh = false): Promise<EmisorInfo> {
    const { rut, tenantId } = await this.credentials();
    const cached = this.emisorCache.get(tenantId);
    if (!refresh && cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.data;
    const res = await this.post(`/sii/eboleta/contribuyente/emisor/${rut}`, {}, 60000);
    if (!res.ok) throw new SiiRejectedError(`No se pudieron leer los datos de la empresa en eBoleta: ${await this.errorMessage(res)}`);
    const body = (await res.json()) as { data?: Partial<EmisorInfo> };
    const data: EmisorInfo = {
      contribuyente: body.data?.contribuyente ?? {},
      sucursales: body.data?.sucursales ?? [],
      usuarios: body.data?.usuarios ?? [],
    };
    this.emisorCache.set(tenantId, { at: Date.now(), data });
    return data;
  }

  /**
   * Código SII de la sucursal desde donde se emite.
   * SII_SUCURSAL en el .env; si no está, la primera sucursal de la empresa en eBoleta.
   */
  private async sucursal(): Promise<number> {
    // Configurada a mano en Configuración → SII (evita consultar eBoleta)
    const fixed = Number((await this.credentials()).sucursal);
    if ((await this.credentials()).sucursal && Number.isFinite(fixed)) return fixed;
    const { sucursales } = await this.emisor();
    const codigo = Number(sucursales[0]?.codigo);
    if (!Number.isFinite(codigo)) {
      throw new SiiRejectedError('La empresa no tiene sucursales en eBoleta: revisa la configuración en el portal del SII');
    }
    return codigo;
  }

  /** Emite una boleta en el portal eBoleta del SII */
  async emitirBoleta(input: EboletaInput): Promise<EboletaResult> {
    const { rut, userRut } = await this.credentials();
    const sucursal = await this.sucursal();
    const dte = {
      // El "vendedor" es quien emite en el portal: la persona con que se entra al SII
      vendedor: userRut,
      Encabezado: {
        IdDoc: { TipoDTE: input.tipo, FchEmis: input.fecha, MedioPago: 1 },
        Emisor: { RUTEmisor: rut, CdgSIISucur: sucursal },
        Receptor: {
          RUTRecep: input.receptorRut,
          // Largos máximos del formato DTE del SII
          RznSocRecep: cut(input.receptorNombre, 100),
          ...(input.receptorDireccion ? { DirRecep: cut(input.receptorDireccion, 70) } : {}),
          ...(input.receptorComuna ? { CmnaRecep: cut(input.receptorComuna, 20) } : {}),
        },
      },
      Detalle: [{ NmbItem: input.item, QtyItem: 1, PrcItem: Math.round(input.total) }],
    };
    const res = await this.post('/sii/eboleta/emitidas/emitir', { dte });

    if (!res.ok) {
      const message = await this.errorMessage(res);
      this.logger.warn(`eBoleta ${res.status}: ${message}`);
      // 4xx = rechazada (datos, clave, token, créditos): no se emitió
      if (res.status >= 400 && res.status < 500) throw new SiiRejectedError(message);
      throw new SiiUnknownError(`API Gateway respondió ${res.status}: ${message}`);
    }

    const body = (await res.json()) as { data?: { folio?: number | string; dte?: number; pdf?: string; pdf_base64?: string } };
    const data = body.data ?? {};
    const folio = Number(data.folio);
    if (!Number.isFinite(folio) || folio <= 0) {
      throw new SiiUnknownError('API Gateway no devolvió el folio de la boleta');
    }
    return {
      folio,
      dte: Number(data.dte ?? input.tipo),
      pdfUrl: data.pdf ?? null,
      pdfBase64: data.pdf_base64 ? data.pdf_base64.replace(/^data:[^,]*,/, '') : null,
      raw: { ...data, pdf_base64: data.pdf_base64 ? '(guardado aparte)' : undefined },
    };
  }

  /**
   * Crea una NOTA DE CRÉDITO (61) como BORRADOR en el Portal MIPYME del SII.
   * No queda emitida: hay que firmarla y enviarla desde el portal.
   * Devuelve el código del borrador.
   */
  async borradorNotaCredito(input: {
    fecha: string;
    receptorRut: string;
    receptorNombre: string;
    receptorDireccion?: string | null;
    receptorComuna?: string | null;
    /** Giro del receptor (si la nota es para una factura) */
    receptorGiro?: string | null;
    item: string;
    total: number;
    boletaTipo: number;
    boletaFolio: string;
    boletaFecha: string;
    /** 1 anula la boleta · 3 corrige montos */
    codRef: 1 | 3;
    razon: string;
  }): Promise<{ draftCode: string; raw: unknown }> {
    const { rut } = await this.credentials();
    const dte = {
      Encabezado: {
        // MntBruto = 1: los montos del detalle vienen con IVA incluido (igual que la boleta)
        IdDoc: { TipoDTE: 61, FchEmis: input.fecha, MntBruto: 1 },
        Emisor: { RUTEmisor: rut },
        Receptor: {
          RUTRecep: input.receptorRut,
          RznSocRecep: cut(input.receptorNombre, 100),
          GiroRecep: cut(input.receptorGiro || 'Particular', 40),
          ...(input.receptorDireccion ? { DirRecep: cut(input.receptorDireccion, 70) } : {}),
          ...(input.receptorComuna ? { CmnaRecep: cut(input.receptorComuna, 20) } : {}),
        },
      },
      Detalle: [{ NmbItem: cut(input.item, 80), QtyItem: 1, PrcItem: Math.round(input.total) }],
      Referencia: [
        {
          TpoDocRef: input.boletaTipo,
          FolioRef: input.boletaFolio,
          FchRef: input.boletaFecha,
          CodRef: input.codRef,
          RazonRef: cut(input.razon, 90),
        },
      ],
    };
    return this.crearBorrador(dte);
  }

  // ------------------------------- Portal MIPYME -------------------------------

  /** Crea un borrador (factura, nota de crédito, guía…) en el Portal MIPYME. Se firma allá */
  async crearBorrador(dte: Record<string, unknown>): Promise<{ draftCode: string; raw: unknown }> {
    const res = await this.post('/sii/mipyme/borradores/emitir', { dte });
    if (!res.ok) {
      const message = await this.errorMessage(res);
      this.logger.warn(`MIPYME borrador ${res.status}: ${message}`);
      throw new SiiRejectedError(message);
    }
    const body = (await res.json()) as { data?: { ehdr_codigo?: string | number } };
    const code = body.data?.ehdr_codigo;
    if (!code) throw new SiiUnknownError('El Portal MIPYME no devolvió el código del borrador');
    return { draftCode: String(code), raw: body.data };
  }

  /** Borradores que siguen sin firmar en el portal (todas las páginas) */
  async borradores(filtros: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const { rut } = await this.credentials();
    return this.paginas(`/sii/mipyme/borradores/documentos/${rut}`, filtros);
  }

  /** Elimina un borrador del portal */
  async eliminarBorrador(code: string): Promise<void> {
    const { rut } = await this.credentials();
    const res = await this.post(`/sii/mipyme/borradores/eliminar/${rut}/${encodeURIComponent(code)}`, {});
    if (!res.ok) throw new SiiRejectedError(await this.errorMessage(res));
  }

  /** Documentos emitidos en el Portal MIPYME entre dos fechas (AAAA-MM-DD) */
  async emitidosMipyme(desde: string, hasta: string): Promise<Record<string, unknown>[]> {
    const { rut } = await this.credentials();
    return this.paginas(`/sii/mipyme/emitidos/documentos/${rut}`, { FEC_DESDE: desde, FEC_HASTA: hasta });
  }

  /** Documentos recibidos (de proveedores) en el Portal MIPYME entre dos fechas */
  async recibidosMipyme(desde: string, hasta: string): Promise<Record<string, unknown>[]> {
    const { rut } = await this.credentials();
    return this.paginas(`/sii/mipyme/recibidos/documentos/${rut}`, { FEC_DESDE: desde, FEC_HASTA: hasta });
  }

  /** PDF de un documento emitido o recibido (por su código del portal) */
  async pdfMipyme(kind: 'emitidos' | 'recibidos', code: string): Promise<Buffer> {
    const { rut } = await this.credentials();
    const res = await this.post(`/sii/mipyme/${kind}/pdf/${rut}/${encodeURIComponent(code)}`, {}, 60000);
    if (!res.ok) throw new SiiRejectedError(`No se pudo obtener el PDF: ${await this.errorMessage(res)}`);
    return this.fileBody(res, 'pdf');
  }

  /** XML de un documento recibido (para leer sus productos) */
  async xmlRecibido(emisorRut: string, dte: number, folio: string, fechaEmision: string): Promise<string> {
    const { rut } = await this.credentials();
    const res = await this.post(
      `/sii/mipyme/recibidos/xml/${rut}/${emisorRut}/${dte}/${encodeURIComponent(folio)}?fecha_emision=${fechaEmision}`,
      {},
      60000,
    );
    if (!res.ok) throw new SiiRejectedError(`No se pudo obtener el XML: ${await this.errorMessage(res)}`);
    const buf = await this.fileBody(res, 'xml');
    // Los XML del SII vienen en ISO-8859-1
    const head = buf.subarray(0, 120).toString('latin1');
    return /encoding="(ISO-8859-1|latin1|windows-1252)"/i.test(head) ? buf.toString('latin1') : buf.toString('utf8');
  }

  /** Razón social, direcciones y giros de un contribuyente (para la factura) */
  async contribuyente(rutReceptor: string): Promise<{
    razonSocial: string | null;
    direcciones: { direccion: string; comuna: string }[];
    actividades: { codigo: string; glosa: string }[];
  }> {
    const { rut } = await this.credentials();
    const res = await this.post(`/sii/mipyme/contribuyentes/info/${rutReceptor}/${rut}/33`, {});
    if (!res.ok) throw new SiiRejectedError(await this.errorMessage(res));
    const body = (await res.json()) as {
      data?: { razon_social?: string; direcciones?: { direccion: string; comuna: string }[]; actividades?: { codigo: string; glosa: string }[] };
    };
    return {
      razonSocial: body.data?.razon_social ?? null,
      direcciones: body.data?.direcciones ?? [],
      actividades: body.data?.actividades ?? [],
    };
  }

  /** Registro de Ventas del SII: resumen del mes por tipo de documento */
  async ventasResumen(periodo: string): Promise<Record<string, unknown>[]> {
    const { rut } = await this.credentials();
    const res = await this.post(`/sii/rcv/ventas/resumen/${rut}/${periodo}?formato=json`, {}, 90000);
    if (!res.ok) throw new SiiRejectedError(await this.errorMessage(res));
    return findRows(await res.json());
  }

  /** Listados paginados del Portal MIPYME (100 por página) */
  private async paginas(path: string, filtros: Record<string, unknown>, max = 20): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= max; page++) {
      const res = await this.post(path, { filtros: { ...filtros, NUM_PAG: page } }, 90000);
      if (!res.ok) {
        const message = await this.errorMessage(res);
        // Sin documentos, el portal a veces responde error
        if (/no (existen|hay|se encontraron)|sin (datos|registros|documentos)/i.test(message)) break;
        throw new SiiRejectedError(message);
      }
      const body = (await res.json()) as { data?: unknown; metadata?: { n_paginas?: number } };
      const list = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : findRows(body.data);
      rows.push(...list);
      const pages = Number(body.metadata?.n_paginas ?? 1);
      if (!list.length || page >= pages) break;
    }
    return rows;
  }

  /** Archivo de la respuesta: binario directo o JSON con el contenido en base64 */
  private async fileBody(res: Response, kind: 'pdf' | 'xml'): Promise<Buffer> {
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      const body = (await res.json()) as { data?: unknown };
      const value = typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? '');
      const b64 = value.replace(/^data:[^;]+;base64,/, '');
      if (kind === 'xml' && value.trim().startsWith('<')) return Buffer.from(value, 'utf8');
      return Buffer.from(b64, 'base64');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Registro de Compras (RCV) de un mes: los documentos que los proveedores le
   * emitieron a la empresa. Devuelve las filas tal como vienen del SII.
   *  - REGISTRO: aceptadas (o con 8 días cumplidos), todas las clases de documento.
   *  - PENDIENTE: recibidas hace menos de 8 días, aún sin aceptar (solo facturas 33).
   */
  async comprasRcv(periodo: string, estado: 'REGISTRO' | 'PENDIENTE'): Promise<Record<string, unknown>[]> {
    const { rut } = await this.credentials();
    const path =
      estado === 'REGISTRO'
        ? `/sii/rcv/compras/detalle/${rut}/${periodo}/0/REGISTRO?tipo=rcv_csv&formato=json`
        : `/sii/rcv/compras/detalle/${rut}/${periodo}/33/PENDIENTE?tipo=rcv&formato=json`;
    const res = await this.post(path, {}, 120000);
    if (!res.ok) {
      const message = await this.errorMessage(res);
      this.logger.warn(`RCV compras ${estado} ${periodo} ${res.status}: ${message}`);
      throw new SiiRejectedError(message);
    }
    return findRows(await res.json());
  }

  /** PDF de una boleta ya emitida */
  async pdfBoleta(folio: number, dte: number, fecha: string): Promise<Buffer> {
    const { rut } = await this.credentials();
    const res = await this.post(
      '/sii/eboleta/emitidas/pdf',
      { contribuyente: rut.split('-')[0], folio, dte, fecha },
      60000,
    );
    if (!res.ok) throw new BadGatewayException(`No se pudo obtener el PDF: ${await this.errorMessage(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Busca en la respuesta la lista de documentos (la forma exacta del JSON puede
 * variar: { data: [...] }, { data: { detalle: [...] } }, [...]).
 */
function findRows(body: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || body === null || typeof body !== 'object') return [];
  if (Array.isArray(body)) {
    if (body.length === 0) return [];
    if (body.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return body as Record<string, unknown>[];
    return [];
  }
  const obj = body as Record<string, unknown>;
  for (const key of ['data', 'detalle', 'documentos', 'registros', 'items']) {
    const rows = findRows(obj[key], depth + 1);
    if (rows.length) return rows;
  }
  for (const value of Object.values(obj)) {
    const rows = findRows(value, depth + 1);
    if (rows.length) return rows;
  }
  return [];
}
