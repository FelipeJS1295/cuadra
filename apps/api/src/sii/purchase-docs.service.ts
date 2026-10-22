import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { purchaseDocuments, suppliers } from '../database/schema/index.js';
import { ReconciliationService } from '../settlements/reconciliation.service.js';
import { SettlementsService } from '../settlements/settlements.service.js';
import { ApiGatewayClient, SiiRejectedError, SiiUnknownError } from './api-gateway.client.js';
import { siiRut } from './rut.js';
import { portalDoc, type PortalDoc } from './sii-rows.js';

/** Producto de una factura de proveedor (leído de su XML) */
export interface InvoiceItem {
  line: number;
  code: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  /** Precio unitario neto */
  price: number;
  discount: number;
  /** Total de la línea, neto */
  amount: number;
}

/** Orden sin factura de proveedor que podría corresponder a un producto de la factura */
export interface OrderSuggestion {
  retailerCode: string;
  retailer: string;
  itemKey: string;
  orderNumber: string;
  orderLabel: string;
  orderDate: string | null;
  productName: string | null;
  sellerSku: string | null;
  /** Lo que se esperaba pagar al proveedor (neto), si el producto tiene costo */
  expectedNet: number | null;
  score: number;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
};

/** Productos (<Detalle>) del XML de un DTE */
export function parseItems(xml: string): InvoiceItem[] {
  const blocks = xml.match(/<(?:\w+:)?Detalle>[\s\S]*?<\/(?:\w+:)?Detalle>/g) ?? [];
  return blocks.map((b, i) => {
    const qty = Number(tag(b, 'QtyItem') ?? 1) || 1;
    const amount = Number(tag(b, 'MontoItem') ?? 0);
    const price = Number(tag(b, 'PrcItem') ?? (amount ? amount / qty : 0));
    return {
      line: Number(tag(b, 'NroLinDet') ?? i + 1),
      code: tag(b, 'VlrCodigo'),
      name: tag(b, 'NmbItem') ?? 'Producto',
      description: tag(b, 'DscItem'),
      quantity: qty,
      unit: tag(b, 'UnmdItem'),
      price: Math.round(price),
      discount: Math.round(Number(tag(b, 'DescuentoMonto') ?? 0)),
      amount: Math.round(amount || price * qty),
    };
  });
}

/** Palabras útiles de un nombre de producto */
const words = (s: string | null | undefined) =>
  new Set(
    (s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !['con', 'para', 'los', 'las', 'del', 'und', 'unidad'].includes(w)),
  );

/** Parecido entre dos nombres (Dice: castiga las palabras que sobran en cualquiera de los dos) */
function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return (2 * common) / (a.size + b.size);
}

const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Facturas de proveedores con datos del Portal MIPYME: su PDF y sus productos (del XML),
 * con sugerencias de a qué órdenes corresponden.
 */
@Injectable()
export class PurchaseDocsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly gateway: ApiGatewayClient,
    private readonly reconciliation: ReconciliationService,
    private readonly settlements: SettlementsService,
  ) {}

  private async doc(id: string) {
    const [d] = await this.db
      .select({
        id: purchaseDocuments.id,
        number: purchaseDocuments.documentNumber,
        type: purchaseDocuments.documentType,
        issueDate: purchaseDocuments.issueDate,
        mipymeCode: purchaseDocuments.mipymeCode,
        items: purchaseDocuments.siiItems,
        supplier: suppliers.name,
        supplierRut: suppliers.taxId,
      })
      .from(purchaseDocuments)
      .innerJoin(suppliers, eq(suppliers.id, purchaseDocuments.supplierId))
      .where(eq(purchaseDocuments.id, id));
    if (!d) throw new NotFoundException('La factura no existe');
    const rut = siiRut(d.supplierRut);
    if (!rut || !d.issueDate) {
      throw new BadRequestException('La factura no tiene RUT del proveedor o fecha: tráela primero con "Traer del SII"');
    }
    return { ...d, supplierRut: rut, issueDate: d.issueDate };
  }

  private fail(err: unknown, what: string): never {
    if (err instanceof SiiRejectedError || err instanceof SiiUnknownError) throw new BadGatewayException(`${what}: ${err.message}`);
    throw err;
  }

  /** Código del documento en el Portal MIPYME (se busca por fecha, RUT, tipo y folio) */
  private async mipymeCode(d: Awaited<ReturnType<PurchaseDocsService['doc']>>) {
    if (d.mipymeCode) return d.mipymeCode;
    const day = new Date(`${d.issueDate}T12:00:00Z`);
    const from = new Date(day.getTime() - 86400000).toISOString().slice(0, 10);
    const to = new Date(day.getTime() + 86400000).toISOString().slice(0, 10);
    const rows = await this.gateway.recibidosMipyme(from, to).catch((err) => this.fail(err, 'No se pudo buscar la factura en el Portal MIPYME'));
    const body = d.supplierRut.split('-')[0];
    const hit = rows
      .map(portalDoc)
      .find((r): r is PortalDoc => r !== null && r.type === d.type && r.folio === d.number && (!r.rutBody || r.rutBody === body));
    if (!hit) {
      throw new NotFoundException(
        'La factura no aparece en los documentos recibidos del Portal MIPYME (puede que el proveedor no la haya enviado por el SII)',
      );
    }
    await this.db.update(purchaseDocuments).set({ mipymeCode: hit.code }).where(eq(purchaseDocuments.id, d.id));
    return hit.code;
  }

  async pdf(id: string): Promise<{ data: Buffer; fileName: string }> {
    const d = await this.doc(id);
    const code = await this.mipymeCode(d);
    const data = await this.gateway.pdfMipyme('recibidos', code).catch((err) => this.fail(err, 'No se pudo obtener el PDF'));
    return { data, fileName: `Factura_${d.number}_${d.supplier.replace(/[^\w]+/g, '_').slice(0, 40)}.pdf` };
  }

  /** Productos de la factura (se leen del XML una vez y quedan guardados) */
  async items(id: string, refresh = false): Promise<InvoiceItem[]> {
    const d = await this.doc(id);
    if (!refresh && Array.isArray(d.items) && d.items.length) return d.items as InvoiceItem[];
    const xml = await this.gateway
      .xmlRecibido(d.supplierRut, d.type, d.number, d.issueDate)
      .catch((err) => this.fail(err, 'No se pudo leer el XML de la factura'));
    const items = parseItems(xml);
    if (!items.length) throw new BadGatewayException('El XML de la factura no trae productos');
    await this.db.update(purchaseDocuments).set({ siiItems: items }).where(eq(purchaseDocuments.id, id));
    return items;
  }

  /**
   * Productos de la factura + órdenes sin factura de proveedor que se parecen a cada uno
   * (por nombre del producto, fecha cercana a la factura y costo esperado).
   */
  async suggestions(id: string, refresh = false) {
    const d = await this.doc(id);
    const items = await this.items(id, refresh);
    const options = this.settlements.availableRetailers();
    const results = await Promise.all(options.map((o) => this.reconciliation.reconcile(o.code).then((r) => ({ o, r })).catch(() => null)));
    const free: (OrderSuggestion & { words: Set<string> })[] = [];
    for (const x of results) {
      if (!x) continue;
      for (const row of x.r.rows) {
        if (!row.itemId || !row.orderNumber || row.documents.length > 0) continue;
        if (row.status === 'SIN_VENTA' || row.status === 'MULTA') continue;
        if (row.orderDate && Math.abs(days(row.orderDate.slice(0, 10), d.issueDate)) > 120) continue;
        free.push({
          retailerCode: x.o.code,
          retailer: x.o.name,
          itemKey: row.itemId,
          orderNumber: row.orderNumber,
          orderLabel: row.orderLabel ?? row.orderNumber,
          orderDate: row.orderDate?.slice(0, 10) ?? null,
          productName: row.productName,
          sellerSku: row.sellerSku,
          expectedNet: row.expectedNet ? Math.round(row.expectedNet) : null,
          score: 0,
          words: words(`${row.productName ?? ''} ${row.sellerSku ?? ''}`),
        });
      }
    }
    return {
      items: items.map((item) => {
        const w = words(`${item.name} ${item.description ?? ''} ${item.code ?? ''}`);
        const list = free
          .map((o) => {
            let score = similarity(w, o.words);
            if (score === 0) return null;
            // Fecha: la orden suele ser antes de la factura (o pocos días después)
            if (o.orderDate) {
              const gap = days(d.issueDate, o.orderDate);
              score += gap >= -7 && gap <= 45 ? 0.3 : gap >= -30 && gap <= 90 ? 0.1 : 0;
            }
            // Costo esperado parecido al precio de la factura
            if (o.expectedNet && item.price) {
              const diff = Math.abs(o.expectedNet - item.price) / item.price;
              score += diff <= 0.05 ? 0.4 : diff <= 0.2 ? 0.2 : 0;
            }
            const { words: _w, ...rest } = o;
            return { ...rest, score: Math.round(score * 100) / 100 };
          })
          .filter((o): o is OrderSuggestion => o !== null && o.score >= 0.45)
          .sort((a, b) => b.score - a.score || (a.orderDate ?? '').localeCompare(b.orderDate ?? ''))
          .slice(0, 12);
        return { ...item, suggestions: list };
      }),
    };
  }
}
