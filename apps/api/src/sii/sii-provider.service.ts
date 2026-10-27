import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../company/settings.service.js';
import { ApiGatewayClient, type EboletaInput } from './api-gateway.client.js';
import { NuboxClassicClient } from './providers/nubox-classic.client.js';
import { NuboxClient } from './providers/nubox.client.js';
import { SiiPortalClient } from './providers/sii-portal.client.js';
import { SimpleApiClient } from './providers/simpleapi.client.js';
import { CAPABILITIES, PROVIDER_NAMES, type IssuedDoc, type SalesSummaryRow, type SiiCapabilities, type SiiProviderKind } from './providers/types.js';
import { amount, picker } from './sii-rows.js';

const NONE: SiiCapabilities = {
  boletas: false,
  notasCredito: false,
  notasCreditoDirectas: false,
  compras: false,
  comprasDetalle: false,
  cuadratura: false,
  facturasYGuias: false,
  facturas: false,
  facturasDirectas: false,
};

export interface CreditNoteRequest {
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  receptorDireccion?: string | null;
  receptorComuna?: string | null;
  receptorGiro?: string | null;
  item: string;
  total: number;
  boletaTipo: number;
  boletaFolio: string;
  boletaFecha: string;
  codRef: 1 | 3;
  razon: string;
}

/** Nota de crédito creada: borrador en el portal del SII (API Gateway) o ya emitida (Nubox) */
export type CreditNoteResult =
  | { kind: 'BORRADOR'; draftCode: string; raw: unknown }
  | { kind: 'EMITIDA'; folio: number; raw: unknown };

/**
 * Conexión con el SII de la empresa actual, sea cual sea su proveedor
 * (API Gateway, SimpleAPI o Nubox). Cada proveedor permite una parte de las funciones:
 * ver CAPABILITIES en providers/types.ts.
 */
@Injectable()
export class SiiProviderService {
  constructor(
    private readonly settings: SettingsService,
    private readonly gateway: ApiGatewayClient,
    private readonly simpleapi: SimpleApiClient,
    private readonly nubox: NuboxClient,
    private readonly nuboxClassic: NuboxClassicClient,
    private readonly portal: SiiPortalClient,
  ) {}

  /**
   * Lo que permite la conexión de la empresa. Con Nubox, si además dejó su RUT y clave del SII,
   * las compras y la cuadratura se leen directo del SII.
   */
  private capabilities(s: Awaited<ReturnType<SettingsService['sii']>>): SiiCapabilities {
    const base = CAPABILITIES[s.provider];
    if ((s.provider === 'NUBOX' || s.provider === 'NUBOX_CLASICO') && SiiPortalClient.ready(s)) {
      return { ...base, compras: true, cuadratura: true };
    }
    return base;
  }

  /** Compras y cuadratura van directo al SII (Nubox + clave del SII) */
  private async direct() {
    const s = await this.settings.sii();
    return (s.provider === 'NUBOX' || s.provider === 'NUBOX_CLASICO') && SiiPortalClient.ready(s);
  }

  async status() {
    const s = await this.settings.sii();
    const missing = this.settings.siiMissing(s);
    const enabled = missing.length === 0;
    return {
      provider: s.provider,
      providerName: PROVIDER_NAMES[s.provider],
      enabled,
      emisorRut: s.emisorRut,
      missing,
      /** Lo que se puede hacer ahora (todo en false si falta configurar) */
      can: enabled ? this.capabilities(s) : NONE,
      /** Lo que permite el proveedor elegido (para explicarlo en pantalla) */
      supports: this.capabilities(s),
      /** Compras y cuadratura se leen directo del SII con la clave tributaria */
      siiDirect: (s.provider === 'NUBOX' || s.provider === 'NUBOX_CLASICO') && SiiPortalClient.ready(s),
    };
  }

  /** Verifica que el proveedor permita la función; si no, un mensaje claro */
  async require(cap: keyof SiiCapabilities, what: string): Promise<SiiProviderKind> {
    const s = await this.settings.sii();
    if (!this.capabilities(s)[cap]) {
      if ((cap === 'compras' || cap === 'cuadratura') && (s.provider === 'NUBOX' || s.provider === 'NUBOX_CLASICO')) {
        throw new BadRequestException(`Para ${what} con ${PROVIDER_NAMES[s.provider]}, agrega tu RUT y tu clave del SII en Configuración → SII`);
      }
      const who = (Object.keys(CAPABILITIES) as SiiProviderKind[]).filter((k) => CAPABILITIES[k][cap]).map((k) => PROVIDER_NAMES[k]);
      throw new BadRequestException(
        `Con ${PROVIDER_NAMES[s.provider]} no puedes ${what}. Eso se hace con ${who.join(' o ')} (Configuración → SII)`,
      );
    }
    return s.provider;
  }

  async emitirBoleta(input: EboletaInput): Promise<IssuedDoc> {
    const provider = await this.require('boletas', 'emitir boletas');
    if (provider === 'NUBOX_CLASICO') {
      return this.nuboxClassic.emitir({
        tipo: 39,
        fecha: input.fecha,
        receptorRut: input.receptorRut,
        receptorNombre: input.receptorNombre,
        receptorDireccion: input.receptorDireccion,
        receptorComuna: input.receptorComuna,
        item: input.item,
        total: input.total,
      });
    }
    if (provider === 'NUBOX') {
      return this.nubox.emitir({
        tipo: 39,
        receptorRut: input.receptorRut,
        receptorNombre: input.receptorNombre,
        receptorDireccion: input.receptorDireccion,
        receptorComuna: input.receptorComuna,
        item: input.item,
        total: input.total,
      });
    }
    return this.gateway.emitirBoleta(input);
  }

  /** Factura (33) emitida al tiro (Nubox). Con API Gateway las facturas son borradores del Portal MIPYME */
  async emitirFactura(input: {
    fecha: string;
    receptor: { rut: string; name: string; activity: string; address: string; commune: string; email?: string | null };
    item: string;
    total: number;
    /** Factura de varias líneas (nombre, cantidad, precio unitario neto) */
    lines?: { name: string; quantity: number; unitNet: number; code?: string | null; description?: string | null }[];
  }): Promise<IssuedDoc> {
    const provider = await this.require('facturas', 'emitir facturas');
    const r = input.receptor;
    if (provider === 'NUBOX_CLASICO') {
      return this.nuboxClassic.emitirFactura({
        fecha: input.fecha,
        receptorRut: r.rut,
        receptorNombre: r.name,
        receptorGiro: r.activity,
        receptorDireccion: r.address,
        receptorComuna: r.commune,
        receptorEmail: r.email,
        item: input.item,
        total: input.total,
        lines: input.lines,
      });
    }
    if (provider === 'NUBOX') {
      return this.nubox.emitir({
        tipo: 33,
        receptorRut: r.rut,
        receptorNombre: r.name,
        receptorGiro: r.activity,
        receptorDireccion: r.address,
        receptorComuna: r.commune,
        item: input.item,
        total: input.total,
        lines: input.lines,
      });
    }
    throw new BadRequestException('Con API Gateway la factura se crea como borrador en el Portal MIPYME');
  }

  async notaCredito(input: CreditNoteRequest): Promise<CreditNoteResult> {
    const provider = await this.require('notasCredito', 'hacer notas de crédito desde Cuadra');
    if (provider === 'NUBOX_CLASICO') {
      const r = await this.nuboxClassic.emitir({
        tipo: 61,
        fecha: input.fecha,
        receptorRut: input.receptorRut,
        receptorNombre: input.receptorNombre,
        receptorDireccion: input.receptorDireccion,
        receptorComuna: input.receptorComuna,
        receptorGiro: input.receptorGiro,
        item: input.item,
        total: input.total,
        referencia: { tipo: input.boletaTipo, folio: input.boletaFolio, fecha: input.boletaFecha, codRef: input.codRef, razon: input.razon },
      });
      return { kind: 'EMITIDA', folio: r.folio, raw: r.raw };
    }
    if (provider === 'NUBOX') {
      const r = await this.nubox.emitir({
        tipo: 61,
        receptorRut: input.receptorRut,
        receptorNombre: input.receptorNombre,
        receptorDireccion: input.receptorDireccion,
        receptorComuna: input.receptorComuna,
        receptorGiro: input.receptorGiro,
        item: input.item,
        total: input.total,
        referencia: {
          tipo: input.boletaTipo,
          folio: input.boletaFolio,
          fecha: input.boletaFecha,
          total: input.total,
          codRef: input.codRef,
          razon: input.razon,
        },
      });
      return { kind: 'EMITIDA', folio: r.folio, raw: r.raw };
    }
    const draft = await this.gateway.borradorNotaCredito(input);
    return { kind: 'BORRADOR', draftCode: draft.draftCode, raw: draft.raw };
  }

  /** Registro de Compras de un mes (AAAA MM sin guion) */
  async comprasRcv(periodo: string, estado: 'REGISTRO' | 'PENDIENTE') {
    const provider = await this.require('compras', 'traer las facturas de proveedores');
    if (provider === 'SIMPLEAPI') return this.simpleapi.comprasRcv(periodo, estado);
    // Directo del SII: "documentos recibidos" no distingue aceptadas / pendientes, van todas juntas
    if (await this.direct()) return estado === 'PENDIENTE' ? [] : this.portal.compras(periodo);
    return this.gateway.comprasRcv(periodo, estado);
  }

  /** Resumen del Registro de Ventas por tipo de documento (mismo formato para todos) */
  async ventasResumen(periodo: string): Promise<SalesSummaryRow[]> {
    const provider = await this.require('cuadratura', 'comparar con el Registro de Ventas');
    if (provider === 'SIMPLEAPI') return this.simpleapi.ventasResumen(periodo);
    if (provider === 'NUBOX') return this.nubox.ventasResumen(periodo);
    if (await this.direct()) return this.portal.resumen(periodo, 'VENTA');
    const rows = await this.gateway.ventasResumen(periodo);
    return rows
      .map((row) => {
        const pick = picker(row);
        const type = Number(pick('rsmntipodocinteger', 'rsmntipodoc', 'dcvtipodoc', 'tipodoc', 'dte', 'tipodocumento'));
        return {
          tipodoc: type,
          nombretipodoc: String(pick('dcvnombretipodoc', 'nombretipodoc', 'tipodocumentonombre') ?? `Tipo ${type}`),
          totaldocumentos: Math.round(amount(pick('rsmntotdoc', 'totaldocumentos', 'cantidad', 'totaldoc'))),
          montototal: Math.round(amount(pick('rsmnmnttotal', 'montototal', 'total'))),
          montoiva: Math.round(amount(pick('rsmnmntiva', 'montoiva', 'iva'))),
        };
      })
      .filter((r) => r.tipodoc > 0);
  }

  /** PDF de un documento emitido por Nubox (API nueva por id o usuario API por folio). null si no es de Nubox */
  async pdfFromRaw(raw: unknown, documentType: number): Promise<Buffer | null> {
    const r = raw as { provider?: string; nuboxId?: number; folio?: number; tipo?: number } | null;
    if (r?.provider === 'NUBOX' && r.nuboxId) return this.nubox.pdf(r.nuboxId, documentType === 39 || documentType === 41);
    if (r?.provider === 'NUBOX_CLASICO' && r.folio) return this.nuboxClassic.pdf(r.folio, r.tipo ?? documentType);
    return null;
  }

  /** PDF de un documento emitido por Nubox (su id queda guardado en la respuesta) */
  nuboxId(raw: unknown): number | null {
    const r = raw as { provider?: string; nuboxId?: number } | null;
    return r?.provider === 'NUBOX' && r.nuboxId ? r.nuboxId : null;
  }

  async pdfNubox(id: number, boleta: boolean) {
    return this.nubox.pdf(id, boleta);
  }

  /** Prueba la conexión del proveedor elegido */
  async test(): Promise<{ ok: boolean; message: string }> {
    const s = await this.settings.sii();
    try {
      if (s.provider === 'SIMPLEAPI') return { ok: true, message: await this.simpleapi.test() };
      if (s.provider === 'NUBOX' || s.provider === 'NUBOX_CLASICO') {
        const nubox = s.provider === 'NUBOX' ? await this.nubox.test() : await this.nuboxClassic.test();
        if (!SiiPortalClient.ready(s)) return { ok: true, message: nubox };
        // También prueba la entrada directa al SII (compras y cuadratura)
        const sii = await this.portal.test().catch((err: Error) => `No pudimos entrar al SII con tu RUT y clave: ${err.message}`);
        return { ok: true, message: `${nubox} ${sii}` };
      }
      const data = await this.gateway.emisor(true);
      const cfg = await this.gateway.config();
      const authorized = data.usuarios.some((u) => String(u.user).replace(/\./g, '').toUpperCase() === cfg.userRut);
      return {
        ok: true,
        message: `Conectado con el SII por API Gateway. Sucursales: ${data.sucursales.length}.${
          authorized ? '' : ' Ojo: tu RUT no aparece como usuario autorizado de la empresa en eBoleta.'
        }`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
