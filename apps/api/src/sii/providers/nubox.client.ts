import { randomUUID } from 'node:crypto';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../../company/settings.service.js';
import { SiiRejectedError, SiiUnknownError } from '../api-gateway.client.js';
import type { IssuedDoc, SalesSummaryRow } from './types.js';

/**
 * Nubox · API de Integraciones de "Factura y Administración" (https://developers.nubox.com/api-docs).
 *
 *   Authorization: Bearer <token del partner>     X-Api-Key: <API key de la empresa>
 *   GET  {url}/v1/sales?period=AAAA-MM&page=&size=     ventas emitidas (header x-total-count)
 *   GET  {url}/v1/sales/{id}                           una venta (folio en "number", estado en "emissionStatus")
 *   GET  {url}/v1/sales/{id}/pdf?template=TEMPLATE_A4  PDF
 *   POST {url}/v1/sales/issuance                       emite (hasta 50 documentos); header X-Idempotence-id
 *
 * La emisión responde 207 con el id de cada documento: es solo el recibo. El folio queda
 * listo unos segundos después y se lee con GET /v1/sales/{id}.
 * Las credenciales de producción se generan en Nubox: engranaje → Integraciones y API → Generar credenciales.
 */

const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NuboxSale {
  id: number;
  number?: string | null;
  type?: { legalCode?: string; name?: string };
  totalAmount?: number;
  totalTaxVatAmount?: number;
  emissionDate?: string;
  emissionStatus?: { id?: number; name?: string; description?: string };
  comments?: string | null;
  dataCl?: { annulled?: boolean; trackId?: number | string };
}

export interface NuboxDocInput {
  tipo: 39 | 61;
  receptorRut: string;
  receptorNombre: string;
  receptorDireccion?: string | null;
  receptorComuna?: string | null;
  receptorGiro?: string | null;
  item: string;
  /** Total con IVA */
  total: number;
  /** Solo notas de crédito: el documento que se corrige */
  referencia?: { tipo: number; folio: string; fecha: string; total: number; codRef: 1 | 3; razon: string };
}

@Injectable()
export class NuboxClient {
  private readonly logger = new Logger(NuboxClient.name);

  constructor(private readonly settings: SettingsService) {}

  private async credentials() {
    const s = await this.settings.sii();
    const missing = this.settings.siiMissing({ ...s, provider: 'NUBOX' });
    if (missing.length) {
      throw new ServiceUnavailableException(`La conexión con Nubox no está configurada. Falta: ${missing.join(', ')} (Conexiones → SII)`);
    }
    return { url: `${s.nuboxUrl}/v1`, token: s.nuboxToken!, apiKey: s.nuboxApiKey! };
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const c = await this.credentials();
    try {
      return await fetch(`${c.url}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${c.token}`,
          'X-Api-Key': c.apiKey,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(init.timeoutMs ?? 60000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new SiiRejectedError(`No se pudo conectar con Nubox (${code})`);
      throw new SiiUnknownError(`Sin respuesta de Nubox: ${(err as Error).message}`);
    }
  }

  /** Mensaje de error de Nubox: { message, errors: [{ field, message }] } */
  private async errorMessage(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text) as { message?: string; errors?: { field?: string; message?: string }[] };
      const details = (json.errors ?? []).map((e) => [e.field, e.message].filter(Boolean).join(': ')).filter(Boolean);
      const msg = [json.message, ...details].filter(Boolean).join(' · ');
      if (msg) return msg;
    } catch {
      /* no es JSON */
    }
    if (res.status === 401 || res.status === 403) return `Nubox rechazó las credenciales (${res.status})`;
    return text.slice(0, 300) || `Error ${res.status}`;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const message = await this.errorMessage(res);
    this.logger.warn(`Nubox ${what} ${res.status}: ${message}`);
    if (res.status >= 500) throw new SiiUnknownError(`Nubox respondió ${res.status}: ${message}`);
    throw new SiiRejectedError(message);
  }

  /** Ventas emitidas de un mes (AAAA-MM), todas las páginas */
  async sales(month: string, max = 50): Promise<NuboxSale[]> {
    const out: NuboxSale[] = [];
    const size = 100;
    for (let page = 1; page <= max; page++) {
      const res = await this.call(`/sales?period=${month}&page=${page}&size=${size}`);
      if (res.status === 204 || res.status === 404) break;
      if (!res.ok) await this.fail(res, 'ventas');
      const body = (await res.json()) as NuboxSale[] | { data?: NuboxSale[] };
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      out.push(...rows);
      const total = Number(res.headers.get('x-total-count') ?? 0);
      if (rows.length < size || (total && out.length >= total)) break;
    }
    return out;
  }

  async sale(id: number | string): Promise<NuboxSale> {
    const res = await this.call(`/sales/${encodeURIComponent(String(id))}`);
    if (!res.ok) await this.fail(res, 'venta');
    return (await res.json()) as NuboxSale;
  }

  /** PDF de una venta (A4, o formato rollo de 80 mm para boletas) */
  async pdf(id: number | string, boleta = false): Promise<Buffer> {
    const res = await this.call(`/sales/${encodeURIComponent(String(id))}/pdf?template=${boleta ? 'TEMPLATE_80MM' : 'TEMPLATE_A4'}`, {
      headers: { Accept: 'application/pdf' },
    });
    if (!res.ok) await this.fail(res, 'pdf');
    return Buffer.from(await res.arrayBuffer());
  }

  /** Emite una boleta (39) o nota de crédito (61) y espera su folio */
  async emitir(input: NuboxDocInput): Promise<IssuedDoc> {
    // Nubox recibe el precio neto y el IVA aparte; el total queda igual al de la venta
    const total = Math.round(input.total);
    const net = Math.round(total / 1.19);
    const vat = total - net;
    const doc: Record<string, unknown> = {
      sequence: 1,
      type: { legalCode: String(input.tipo) },
      client: {
        tradeName: cut(input.receptorNombre || 'Cliente', 100),
        identification: { type: 1, value: input.receptorRut },
        mainActivity: cut(input.receptorGiro || 'Particular', 40),
        ...(input.receptorDireccion ? { address: cut(input.receptorDireccion, 70) } : {}),
      },
      saleType: { id: 1 },
      paymentForm: { id: 1 },
      details: [
        {
          order: 1,
          quantity: 1,
          productDescription: cut(input.item, 80),
          price: net,
          uom: { code: 'UNID' },
          subjectToTax: true,
          taxes: [{ legalCode: '14', amount: vat }],
          discountsAndSurcharges: [],
        },
      ],
    };
    if (input.referencia) {
      const r = input.referencia;
      doc.references = [
        {
          legalCode: String(r.tipo),
          documentNumber: r.folio,
          documentEmissionDate: `${r.fecha}T00:00:00`,
          documentTotalAmount: Math.round(r.total),
          motiveTypeId: r.codRef,
          motiveDescription: cut(r.razon, 90),
        },
      ];
    }

    const res = await this.call('/sales/issuance', {
      method: 'POST',
      headers: { 'X-Idempotence-id': randomUUID() },
      body: JSON.stringify([doc]),
      timeoutMs: 90000,
    });
    if (!res.ok && res.status !== 207) await this.fail(res, 'emisión');
    const body = (await res.json()) as { id?: number; sequence?: number; errors?: { field?: string; message?: string }[] | null }[];
    const item = Array.isArray(body) ? body[0] : undefined;
    if (item?.errors?.length) {
      throw new SiiRejectedError(item.errors.map((e) => [e.field, e.message].filter(Boolean).join(': ')).join(' · '));
    }
    if (!item?.id) throw new SiiUnknownError('Nubox no devolvió el id del documento');

    // El folio queda listo unos segundos después
    let last: NuboxSale | null = null;
    for (let i = 0; i < 10; i++) {
      await sleep(i === 0 ? 1500 : 2500);
      last = await this.sale(item.id).catch(() => last);
      const folio = Number(last?.number);
      const status = `${last?.emissionStatus?.name ?? ''} ${last?.comments ?? ''}`.toLowerCase();
      if (/rechaz|error/.test(status)) throw new SiiRejectedError(`Nubox no pudo emitir el documento: ${last?.comments ?? last?.emissionStatus?.name}`);
      if (Number.isFinite(folio) && folio > 0 && last?.emissionStatus?.id === 1) {
        return { folio, dte: input.tipo, pdfUrl: null, pdfBase64: null, raw: { provider: 'NUBOX', nuboxId: item.id, sale: last } };
      }
    }
    throw new SiiUnknownError(
      `Nubox recibió el documento (id ${item.id}) pero todavía no entrega el folio. Revísalo en Nubox en unos minutos.`,
    );
  }

  /** Resumen del mes por tipo de documento, armado con las ventas emitidas en Nubox */
  async ventasResumen(periodo: string): Promise<SalesSummaryRow[]> {
    const month = `${periodo.slice(0, 4)}-${periodo.slice(4, 6)}`;
    const byType = new Map<number, SalesSummaryRow>();
    for (const s of await this.sales(month)) {
      if (s.dataCl?.annulled) continue;
      if (s.emissionStatus?.id !== undefined && s.emissionStatus.id !== 1) continue;
      const type = Number(s.type?.legalCode);
      if (!type) continue;
      const row = byType.get(type) ?? { tipodoc: type, nombretipodoc: s.type?.name ?? `Tipo ${type}`, totaldocumentos: 0, montototal: 0, montoiva: 0 };
      row.totaldocumentos++;
      row.montototal += Math.round(Number(s.totalAmount ?? 0));
      row.montoiva += Math.round(Number(s.totalTaxVatAmount ?? 0));
      byType.set(type, row);
    }
    return [...byType.values()];
  }

  async test(): Promise<string> {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date()).slice(0, 7);
    const res = await this.call(`/sales?period=${month}&page=1&size=1`);
    if (res.status !== 204 && res.status !== 404 && !res.ok) await this.fail(res, 'prueba');
    const total = Number(res.headers.get('x-total-count') ?? 0);
    return `Conectado con Nubox. Ventas emitidas este mes: ${total}.`;
  }
}
