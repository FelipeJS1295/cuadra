import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { PurchasesImportService } from './purchases-import.service.js';

const monthSchema = z.string({ error: 'Falta el mes' }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido (AAAA-MM)');

/**
 * Facturas de compra desde el Registro de Compras y Ventas (RCV) del SII.
 *   GET  /api/sii/compras?month=2026-10            lo que hay en el SII y si ya está en el ERP
 *   POST /api/sii/compras/importar { month, keys }  trae al ERP los documentos elegidos
 */
@Controller('sii/compras')
export class PurchasesImportController {
  constructor(private readonly service: PurchasesImportService) {}

  @Get()
  preview(@Query('month') month: string) {
    return this.service.preview(validate(monthSchema, month));
  }

  @Post('importar')
  @HttpCode(200)
  import(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { month, keys } = validate(
      z.object({ month: monthSchema, keys: z.array(z.string().min(1).max(80)).min(1, 'No elegiste documentos').max(2000) }),
      body,
    );
    return this.service.import(month, keys, user?.id ?? null);
  }
}
