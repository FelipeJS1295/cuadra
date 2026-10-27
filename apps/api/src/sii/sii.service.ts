import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { customerReceipts, retailers, salesRecords } from '../database/schema/index.js';
import { showsCustomerOrderId } from '../settlements/reconciliation.service.js';
import { RetailApiService } from '../retail-api/retail-api.service.js';
import { SalesService } from '../sales/sales.service.js';
import { ApiGatewayClient, SiiRejectedError } from './api-gateway.client.js';
import { RUT_GENERICO, siiRut } from './rut.js';
import { SiiProviderService } from './sii-provider.service.js';

/** Nombre del ítem: el SII acepta hasta 80 caracteres */
const ITEM_MAX = 80;

const todayCL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());

export interface BoletaPreview {
  retailerCode: string;
  orderNumber: string;
  /** El cliente pidió factura: no se emite como boleta */
  wantsInvoice: boolean;
  item: string;
  total: number;
  productTotal: number;
  shippingTotal: number;
  receptorRut: string;
  /** Nombre del cliente que va en la boleta (si no viene, "Cliente") */
  receptorName: string;
  receptorAddress: string | null;
  receptorCommune: string | null;
  /** El RUT del cliente no vino o no es válido: se usa el genérico */
  genericReceptor: boolean;
  existing: { id: string; number: string; status: string } | null;
  /** Fecha de la orden (AAAA-MM-DD) */
  orderDate: string | null;
  /** Fecha con que se emite la boleta: la de la orden (si no hay, o es futura, hoy) */
  issueDate: string;
}

@Injectable()
export class SiiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly sales: SalesService,
    private readonly gateway: ApiGatewayClient,
    private readonly provider: SiiProviderService,
    private readonly retail: RetailApiService,
  ) {}

  /** Proveedor del SII elegido, si está configurado y qué permite hacer */
  status() {
    return this.provider.status();
  }

  /** Diagnóstico: cómo ve el SII a la empresa en eBoleta (sucursales y usuarios autorizados) */
  async emisor() {
    const cfg = await this.gateway.config();
    try {
      const data = await this.gateway.emisor(true);
      return {
        ok: true,
        emisorRut: cfg.rut,
        usuarioRut: cfg.userRut,
        sucursalUsada: data.sucursales[0]?.codigo ?? null,
        usuarioAutorizado: data.usuarios.some((u) => String(u.user).replace(/\./g, '').toUpperCase() === cfg.userRut),
        ...data,
      };
    } catch (err) {
      return { ok: false, emisorRut: cfg.rut, usuarioRut: cfg.userRut, error: (err as Error).message };
    }
  }

  private async retailerId(code: string) {
    const [r] = await this.db.select({ id: retailers.id }).from(retailers).where(eq(retailers.code, code.toUpperCase()));
    if (!r) throw new BadRequestException(`Retailer "${code}" no existe`);
    return r.id;
  }

  private async existing(retailerId: string, orderNumber: string) {
    const [row] = await this.db
      .select({ id: customerReceipts.id, number: customerReceipts.receiptNumber, status: customerReceipts.status })
      .from(customerReceipts)
      .where(and(eq(customerReceipts.retailerId, retailerId), eq(customerReceipts.orderNumber, orderNumber)));
    return row ?? null;
  }

  /** Lo que se va a emitir (se muestra antes de confirmar) */
  async preview(retailerCode: string, orderNumber: string): Promise<BoletaPreview> {
    const data = await this.sales.customerData(retailerCode, orderNumber);
    const names = [...new Set(data.lines.map((l) => (l.quantity > 1 ? `${l.quantity} x ` : '') + (l.productName ?? 'Producto')))].join(' + ');
    const suffix = data.shippingTotal > 0 ? ' + despacho' : '';
    const item = names.length + suffix.length > ITEM_MAX ? `${names.slice(0, ITEM_MAX - suffix.length - 1)}…${suffix}` : `${names}${suffix}`;
    const rut = siiRut(data.customer.rut);
    const retailerId = await this.retailerId(retailerCode);
    const [dateRow] = await this.db
      .select({ orderDate: sql<string | null>`min(${salesRecords.orderDate})::text` })
      .from(salesRecords)
      .where(and(eq(salesRecords.retailerId, retailerId), eq(salesRecords.orderNumber, orderNumber)));
    const orderDate = dateRow?.orderDate?.slice(0, 10) ?? null;
    const today = todayCL();
    return {
      retailerCode: retailerCode.toUpperCase(),
      orderNumber,
      wantsInvoice: data.documentType === 'FACTURA',
      item,
      total: data.total,
      productTotal: data.productTotal,
      shippingTotal: data.shippingTotal,
      receptorRut: rut ?? RUT_GENERICO,
      receptorName: (data.customer.name ?? data.shipping.name ?? '').trim() || 'Cliente',
      receptorAddress: data.shipping.address,
      receptorCommune: data.shipping.commune,
      genericReceptor: !rut,
      existing: await this.existing(retailerId, orderNumber),
      orderDate,
      issueDate: orderDate && orderDate <= today ? orderDate : today,
    };
  }

  /**
   * Emite la boleta de una orden en el SII (portal eBoleta) y la guarda en el ERP.
   * Nunca emite dos veces la misma orden: antes de llamar al SII deja la orden "EMITIENDO".
   */
  async emitirBoleta(retailerCode: string, orderNumber: string, userId: string | null) {
    const p = await this.preview(retailerCode, orderNumber);
    if (p.wantsInvoice) throw new BadRequestException('Esta orden pide FACTURA: no se puede emitir como boleta');
    if (p.total <= 0) throw new BadRequestException('La orden no tiene monto');
    if (p.existing) {
      const why =
        p.existing.status === 'EMITIENDO'
          ? 'se está emitiendo en este momento'
          : p.existing.status === 'BORRADOR'
            ? 'tiene una factura en borrador en el Portal MIPYME'
            : p.existing.status === 'REVISAR'
            ? 'tiene un intento sin confirmar: revísalo en el portal eBoleta del SII'
            : `ya tiene la boleta N° ${p.existing.number}`;
      throw new ConflictException(`La orden ${orderNumber} ${why}`);
    }

    // Antes de reservar: el proveedor del SII de la empresa tiene que poder emitir boletas
    await this.provider.require('boletas', 'emitir boletas');

    const retailerId = await this.retailerId(retailerCode);
    // 1. Reserva la orden (el índice único impide dos emisiones al mismo tiempo)
    let receiptId: string;
    try {
      const [row] = await this.db
        .insert(customerReceipts)
        .values({
          retailerId,
          orderNumber,
          receiptNumber: 'EMITIENDO',
          totalGross: String(p.total),
          documentType: 39,
          status: 'EMITIENDO',
          createdBy: userId,
        })
        .returning({ id: customerReceipts.id });
      receiptId = row.id;
    } catch {
      throw new ConflictException(`La orden ${orderNumber} ya tiene boleta o se está emitiendo`);
    }

    // 2. Emite en el SII (por API Gateway o Nubox, según la empresa)
    const { providerName } = await this.provider.status();
    try {
      const result = await this.provider.emitirBoleta({
        tipo: 39,
        receptorRut: p.receptorRut,
        receptorNombre: p.receptorName,
        receptorDireccion: p.receptorAddress,
        receptorComuna: p.receptorCommune,
        item: p.item,
        total: p.total,
        fecha: p.issueDate,
      });
      const [saved] = await this.db
        .update(customerReceipts)
        .set({
          receiptNumber: String(result.folio),
          documentType: result.dte,
          status: 'EMITIDA',
          issuedAt: p.issueDate,
          pdfUrl: result.pdfUrl,
          pdfData: result.pdfBase64,
          siiResponse: result.raw,
        })
        .where(eq(customerReceipts.id, receiptId))
        .returning({ id: customerReceipts.id, number: customerReceipts.receiptNumber });
      // Paris exige subir la boleta a su portal: se envía altiro (si falla, queda para reenviar)
      const retail = await this.sendToRetailer(saved.id, { onlyIfReady: true });
      return { ok: true as const, id: saved.id, folio: result.folio, total: p.total, orderNumber, issuedAt: p.issueDate, retail };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof SiiRejectedError) {
        // Rechazada: no se emitió, se libera la orden para reintentar
        await this.db.delete(customerReceipts).where(eq(customerReceipts.id, receiptId));
        throw new BadGatewayException(`El SII / ${providerName} rechazó la boleta: ${message}`);
      }
      // No se sabe si quedó emitida: se marca para revisar en el portal (no se reintenta solo)
      await this.db
        .update(customerReceipts)
        .set({ status: 'REVISAR', receiptNumber: 'REVISAR', siiResponse: { error: message } })
        .where(eq(customerReceipts.id, receiptId));
      throw new BadGatewayException(
        `No se pudo confirmar la boleta (${message}). Revisa en ${providerName.startsWith('Nubox') ? 'Nubox' : 'el portal eBoleta del SII'} si quedó emitida: ` +
          'si quedó, anota su N° en la orden; si no, quita el intento y vuelve a emitir.',
      );
    }
  }

  /** Emite varias boletas, una tras otra. Devuelve el resultado de cada una */
  async emitirVarias(orders: { retailerCode: string; orderNumber: string }[], userId: string | null) {
    const results = [];
    for (const o of orders) {
      try {
        results.push(await this.emitirBoleta(o.retailerCode, o.orderNumber, userId));
      } catch (err) {
        results.push({ ok: false as const, orderNumber: o.orderNumber, error: (err as Error).message });
        // Si falla la configuración o las credenciales, no tiene sentido seguir
        if (/configurad|clave|token|autentic|crédito|credito|Conexiones → SII|Configuración → SII/i.test((err as Error).message)) break;
      }
    }
    return {
      emitted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /**
   * N° de orden de compra como se ve en Ventas (Walmart: el del cliente, no la PO "P…"),
   * limpio para usarlo como nombre de archivo.
   */
  private async orderLabel(retailerId: string, orderNumber: string): Promise<{ code: string | null; label: string }> {
    const [row] = await this.db
      .select({ code: retailers.code, orderId: sql<string | null>`min(${salesRecords.orderId})` })
      .from(retailers)
      .leftJoin(salesRecords, and(eq(salesRecords.retailerId, retailers.id), eq(salesRecords.orderNumber, orderNumber)))
      .where(eq(retailers.id, retailerId))
      .groupBy(retailers.code);
    const label = row && showsCustomerOrderId(row.code) ? (row.orderId ?? orderNumber) : orderNumber;
    return { code: row?.code ?? null, label: label.replace(/[^\w.-]+/g, '_') };
  }

  /** PDF de una boleta emitida desde el sistema (el archivo se llama como la orden de compra) */
  async pdf(receiptId: string): Promise<{ data: Buffer; fileName: string }> {
    const [r] = await this.db.select().from(customerReceipts).where(eq(customerReceipts.id, receiptId));
    if (!r) throw new NotFoundException('La boleta no existe');
    if (r.status !== 'EMITIDA') throw new BadRequestException('Esta boleta no se emitió desde el sistema');
    // Falabella: "<N° orden>_<N° documento>.pdf" · resto: "<N° orden>.pdf"
    const { code, label } = await this.orderLabel(r.retailerId, r.orderNumber);
    const fileName = code === 'FALABELLA' ? `${label}_${r.receiptNumber}.pdf` : `${label}.pdf`;
    if (r.pdfData) return { data: Buffer.from(r.pdfData, 'base64'), fileName };
    // Emitida por Nubox
    const fromNubox = await this.provider.pdfFromRaw(r.siiResponse, r.documentType);
    if (fromNubox) {
      const data = fromNubox;
      await this.db.update(customerReceipts).set({ pdfData: data.toString('base64') }).where(eq(customerReceipts.id, r.id));
      return { data, fileName };
    }
    // Factura firmada en el Portal MIPYME
    if (r.mipymeCode) {
      const data = await this.gateway.pdfMipyme('emitidos', r.mipymeCode);
      await this.db.update(customerReceipts).set({ pdfData: data.toString('base64') }).where(eq(customerReceipts.id, r.id));
      return { data, fileName };
    }
    const data = await this.gateway.pdfBoleta(Number(r.receiptNumber), r.documentType, r.issuedAt ?? todayCL());
    await this.db.update(customerReceipts).set({ pdfData: data.toString('base64') }).where(eq(customerReceipts.id, r.id));
    return { data, fileName };
  }

  // ------------------------------------------------------------------ Enviar al retailer

  /**
   * Sube la boleta (o factura) emitida al portal del retailer, si el retailer lo recibe por API
   * (hoy Paris). Nunca lanza error: deja el resultado anotado en el documento.
   * Con onlyIfReady, si el retailer no recibe boletas o no está conectado, no hace nada (null).
   */
  async sendToRetailer(receiptId: string, opts: { onlyIfReady?: boolean } = {}): Promise<{ ok: boolean; retailer: string; message: string } | null> {
    const [r] = await this.db
      .select({ receipt: customerReceipts, code: retailers.code, name: retailers.name })
      .from(customerReceipts)
      .innerJoin(retailers, eq(retailers.id, customerReceipts.retailerId))
      .where(eq(customerReceipts.id, receiptId));
    if (!r) throw new NotFoundException('El documento no existe');
    const ready = await this.retail.invoiceUploadReady(r.code);
    if (!ready) {
      if (opts.onlyIfReady) return null;
      throw new BadRequestException(`${r.name} no recibe boletas por API o no está conectado (Configuración → Conexiones)`);
    }
    const label = ready.label;
    const doc = r.receipt.documentType === 33 ? 'factura' : 'boleta';
    let result: { ok: boolean; retailer: string; message: string };
    try {
      if (r.receipt.status !== 'EMITIDA') throw new Error(`Solo se envían documentos emitidos desde Cuadra (esta ${doc} está ${r.receipt.status.toLowerCase()})`);
      const { data, fileName } = await this.pdf(receiptId);
      const res = await this.retail.uploadInvoice(r.code, {
        orderNumber: r.receipt.orderNumber,
        number: r.receipt.receiptNumber,
        type: doc,
        issuedAt: r.receipt.issuedAt ?? todayCL(),
        externalOrderId: null,
        pdf: data,
        fileName,
        description: `${doc === 'factura' ? 'Factura' : 'Boleta'} N° ${r.receipt.receiptNumber} de la orden ${r.receipt.orderNumber}`,
      });
      const message = res.already ? `Ya estaba en ${label}` : `Enviada a ${label}`;
      await this.db
        .update(customerReceipts)
        .set({ retailStatus: 'ENVIADA', retailMessage: message, retailSentAt: new Date(), retailRef: res.id?.slice(0, 80) ?? null })
        .where(eq(customerReceipts.id, receiptId));
      result = { ok: true, retailer: label, message };
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.db
        .update(customerReceipts)
        .set({ retailStatus: 'ERROR', retailMessage: message, retailSentAt: new Date() })
        .where(eq(customerReceipts.id, receiptId));
      result = { ok: false, retailer: label, message };
    }
    return result;
  }

  /** Envía al retailer todos los documentos emitidos que aún no se le envían (o que fallaron) */
  async sendPendingToRetailer(retailerCode: string) {
    const code = retailerCode.toUpperCase();
    if (!(await this.retail.invoiceUploadReady(code))) throw new BadRequestException('Ese retailer no recibe boletas por API o no está conectado');
    const rows = await this.db
      .select({ id: customerReceipts.id, orderNumber: customerReceipts.orderNumber })
      .from(customerReceipts)
      .innerJoin(retailers, eq(retailers.id, customerReceipts.retailerId))
      .where(
        and(
          eq(retailers.code, code),
          eq(customerReceipts.status, 'EMITIDA'),
          sql`coalesce(${customerReceipts.retailStatus}, '') <> 'ENVIADA'`,
        ),
      )
      .orderBy(customerReceipts.createdAt)
      .limit(200);
    const results = [];
    for (const row of rows) results.push({ orderNumber: row.orderNumber, ...(await this.sendToRetailer(row.id))! });
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }
}
