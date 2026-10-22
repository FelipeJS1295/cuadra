import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { PurchasesService } from './purchases.service.js';

/** Monto neto en pesos, mayor a 0: acepta 125000, "125000", "125.000" o "$125.000" */
const amountSchema = z
  .union([z.number(), z.string()], { error: 'Falta el monto' })
  .transform((value, ctx) => {
    const text =
      typeof value === 'number'
        ? String(value)
        : value.trim().replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
    const n = Number(text);
    if (text === '' || !Number.isFinite(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Cada monto debe ser un número mayor a 0' });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

const paymentSchema = z.object({
  /** Monto pagado, con IVA */
  amount: amountSchema,
  paidAt: z
    .string({ error: 'Falta la fecha del pago' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (usa AAAA-MM-DD)'),
  method: z.string().trim().max(40).nullish().transform((v) => v || null),
  note: z.string().trim().max(500).nullish().transform((v) => v || null),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato AAAA-MM-DD');

const documentSchema = z.object({
  supplier: z
    .string({ error: 'Falta el proveedor' })
    .trim()
    .min(1, 'Falta el proveedor')
    .max(200, 'El proveedor puede tener máximo 200 caracteres'),
  documentNumber: z
    .string({ error: 'Falta el N° de documento' })
    .trim()
    .min(1, 'Falta el N° de documento')
    .max(50, 'El N° de documento puede tener máximo 50 caracteres'),
  retailerCode: z.string({ error: 'Falta el retailer' }).min(1),
  /** Fecha de la factura (AAAA-MM-DD) */
  issueDate: dateSchema.nullish(),
  lines: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(80),
        orderNumber: z.string().max(50).nullable(),
        productName: z.string().nullable(),
        /** Monto neto (sin IVA): acepta 125000, "125.000", "125000,5" */
        amountNet: amountSchema,
      }),
      { error: 'Faltan las órdenes' },
    )
    .min(1, 'Selecciona al menos una orden'),
});

/**
 * Documentos de compra (facturas del proveedor) ligados a órdenes de la conciliación.
 *   GET    /api/purchases/suppliers
 *   POST   /api/purchases/documents     { supplier, documentNumber, retailerCode, lines[] }
 *   DELETE /api/purchases/lines/:id     quita una orden del documento
 *   GET    /api/purchases/invoices                facturas con total, pagado y saldo
 *   GET    /api/purchases/invoices/:id            factura con sus órdenes y pagos
 *   PATCH  /api/purchases/invoices/:id            { issueDate }  fecha de la factura
 *   POST   /api/purchases/invoices/:id/payments   { amount, paidAt, method?, note? }
 *   DELETE /api/purchases/payments/:id
 * Las rutas que modifican quedan para ADMIN y OPERADOR (regla general del AuthGuard).
 */
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('suppliers')
  suppliers() {
    return this.purchases.listSuppliers();
  }

  @Post('documents')
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.purchases.createDocument(validate(documentSchema, body), user?.id ?? null);
  }

  @Delete('lines/:id')
  removeLine(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.deleteLine(id);
  }

  @Get('invoices')
  invoices() {
    return this.purchases.listInvoices();
  }

  @Get('invoices/:id')
  invoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getInvoice(id);
  }

  @Patch('invoices/:id')
  setIssueDate(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { issueDate } = validate(z.object({ issueDate: dateSchema }), body);
    return this.purchases.setIssueDate(id, issueDate);
  }

  @Post('invoices/:id/payments')
  addPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.purchases.addPayment(id, validate(paymentSchema, body), user?.id ?? null);
  }

  @Delete('payments/:id')
  removePayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.deletePayment(id);
  }
}