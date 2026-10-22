import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../company/settings.service.js';
import { ApiGatewayClient, type EboletaInput } from './api-gateway.client.js';
import { NuboxClient } from './providers/nubox.client.js';
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
  ) {}

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
      can: enabled ? CAPABILITIES[s.provider] : NONE,
      /** Lo que permite el proveedor elegido (para explicarlo en pantalla) */
      supports: CAPABILITIES[s.provider],
    };
  }

  /** Verifica que el proveedor permita la función; si no, un mensaje claro */
  async require(cap: keyof SiiCapabilities, what: string): Promise<SiiProviderKind> {
    const s = await this.settings.sii();
    if (!CAPABILITIES[s.provider][cap]) {
      const who = (Object.keys(CAPABILITIES) as SiiProviderKind[]).filter((k) => CAPABILITIES[k][cap]).map((k) => PROVIDER_NAMES[k]);
      throw new BadRequestException(
        `Con ${PROVIDER_NAMES[s.provider]} no puedes ${what}. Eso se hace con ${who.join(' o ')} (Conexiones → SII)`,
      );
    }
    return s.provider;
  }

  async emitirBoleta(input: EboletaInput): Promise<IssuedDoc> {
    const provider = await this.require('boletas', 'emitir boletas');
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

  async notaCredito(input: CreditNoteRequest): Promise<CreditNoteResult> {
    const provider = await this.require('notasCredito', 'hacer notas de crédito desde Cuadra');
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
    return this.gateway.comprasRcv(periodo, estado);
  }

  /** Resumen del Registro de Ventas por tipo de documento (mismo formato para todos) */
  async ventasResumen(periodo: string): Promise<SalesSummaryRow[]> {
    const provider = await this.require('cuadratura', 'comparar con el Registro de Ventas');
    if (provider === 'SIMPLEAPI') return this.simpleapi.ventasResumen(periodo);
    if (provider === 'NUBOX') return this.nubox.ventasResumen(periodo);
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
      if (s.provider === 'NUBOX') return { ok: true, message: await this.nubox.test() };
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
