import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { GuidesService } from './guides.service.js';
import { MipymeService } from './mipyme.service.js';
import { PurchaseDocsService } from './purchase-docs.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const text = (max: number, label: string) => z.string({ error: `Falta ${label}` }).trim().min(1, `Falta ${label}`).max(max, `${label}: máximo ${max} caracteres`);

const facturaSchema = z.object({
  retailerCode: z.string().min(1),
  orderNumber: z.string().min(1).max(50),
  receptor: z.object({
    rut: text(12, 'el RUT'),
    name: text(100, 'la razón social'),
    activity: text(40, 'el giro'),
    address: text(70, 'la dirección'),
    commune: text(20, 'la comuna'),
  }),
});

const guideSchema = z.object({
  guideDate: dateSchema,
  transferType: z.number().int(),
  receptorRut: text(12, 'el RUT del destinatario'),
  receptorName: text(100, 'el nombre del destinatario'),
  receptorActivity: z.string().trim().max(40).nullish().transform((v) => v || null),
  address: z.string().trim().max(70).nullish().transform((v) => v || null),
  commune: z.string().trim().max(20).nullish().transform((v) => v || null),
  items: z
    .array(z.object({ name: text(80, 'el producto'), quantity: z.number().positive('Cantidad inválida'), price: z.number().min(0) }))
    .min(1, 'Agrega al menos un producto')
    .max(60),
  reference: z.string().trim().max(80).nullish().transform((v) => v || null),
  notes: z.string().trim().max(500).nullish().transform((v) => v || null),
});

function sendPdf(res: Response, data: Buffer, fileName: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(data);
}

/**
 * Portal MIPYME del SII.
 *   POST   /api/sii/mipyme/sincronizar                revisa qué borradores ya se firmaron
 *   GET    /api/sii/mipyme/contribuyente/:rut          datos de una empresa (para facturar)
 *   GET    /api/sii/mipyme/facturas/preview?retailer=&order=
 *   POST   /api/sii/mipyme/facturas                    factura (33) de una orden como borrador
 *   DELETE /api/sii/mipyme/facturas/:id                quita una factura en borrador
 *   GET    /api/sii/mipyme/ventas/:month               ventas del ERP vs Registro de Ventas del SII
 *   GET    /api/sii/mipyme/notas-credito/:id/pdf
 *   GET    /api/sii/mipyme/compras/:id/pdf             PDF de la factura del proveedor
 *   GET    /api/sii/mipyme/compras/:id/productos       productos (XML) + órdenes sugeridas
 *   GET|POST /api/sii/mipyme/guias · PATCH guias/:id/folio · DELETE guias/:id · GET guias/:id/pdf
 */
@Controller('sii/mipyme')
export class MipymeController {
  constructor(
    private readonly mipyme: MipymeService,
    private readonly guides: GuidesService,
    private readonly purchases: PurchaseDocsService,
  ) {}

  @Post('sincronizar')
  @HttpCode(200)
  sync() {
    return this.mipyme.sync();
  }

  @Get('contribuyente/:rut')
  contribuyente(@Param('rut') rut: string) {
    return this.mipyme.contribuyente(rut);
  }

  @Get('facturas/preview')
  facturaPreview(@Query('retailer') retailer: string, @Query('order') order: string) {
    const { r, o } = validate(z.object({ r: z.string().min(1), o: z.string().min(1).max(50) }), { r: retailer, o: order });
    return this.mipyme.facturaPreview(r, o);
  }

  @Post('facturas')
  @HttpCode(200)
  createFactura(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const input = validate(facturaSchema, body);
    return this.mipyme.createFactura(input.retailerCode, input.orderNumber, input.receptor, user?.id ?? null);
  }

  @Delete('facturas/:id')
  deleteFactura(@Param('id', ParseUUIDPipe) id: string) {
    return this.mipyme.deleteFactura(id);
  }

  @Get('ventas/:month')
  salesCheck(@Param('month') month: string) {
    return this.mipyme.salesCheck(month);
  }

  @Get(['notas-credito/:id/pdf', 'notas-credito/:id/pdf/:file'])
  async ncPdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.mipyme.emittedPdf('nota-credito', id);
    sendPdf(res, data, fileName);
  }

  @Get(['compras/:id/pdf', 'compras/:id/pdf/:file'])
  async purchasePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.purchases.pdf(id);
    sendPdf(res, data, fileName);
  }

  @Get('compras/:id/productos')
  purchaseItems(@Param('id', ParseUUIDPipe) id: string, @Query('refresh') refresh?: string) {
    return this.purchases.suggestions(id, refresh === '1');
  }

  @Get('guias')
  listGuides() {
    return this.guides.list();
  }

  @Post('guias')
  @HttpCode(200)
  createGuide(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.guides.create(validate(guideSchema, body), user?.id ?? null);
  }

  @Patch('guias/:id/folio')
  confirmGuide(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { folio, issuedAt } = validate(z.object({ folio: text(30, 'el folio'), issuedAt: dateSchema }), body);
    return this.guides.confirm(id, folio, issuedAt);
  }

  @Delete('guias/:id')
  deleteGuide(@Param('id', ParseUUIDPipe) id: string) {
    return this.guides.remove(id);
  }

  @Get(['guias/:id/pdf', 'guias/:id/pdf/:file'])
  async guidePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.mipyme.emittedPdf('guia', id);
    sendPdf(res, data, fileName);
  }
}
