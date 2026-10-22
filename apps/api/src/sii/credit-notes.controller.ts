import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/decorators.js';
import { costSchema, validate } from '../products/catalog.validation.js';
import { CreditNotesService } from './credit-notes.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato AAAA-MM-DD');

const baseSchema = z.object({
  retailerCode: z.string({ error: 'Falta el retailer' }).min(1),
  orderNumber: z.string({ error: 'Falta la orden' }).min(1).max(50),
  amountGross: costSchema.transform(Number),
  refCode: z.union([z.literal(1), z.literal(3)], { error: 'Tipo de nota inválido' }),
  reason: z.string({ error: 'Falta el motivo' }).trim().min(3, 'Escribe el motivo').max(90, 'Máximo 90 caracteres'),
  returnId: z.uuid().nullish(),
});

const registerSchema = baseSchema.extend({
  folio: z.string({ error: 'Falta el N° de la nota' }).trim().min(1, 'Falta el N° de la nota').max(30),
  issuedAt: dateSchema,
});

/**
 * Notas de crédito sobre boletas.
 *   GET    /api/credit-notes                 todas
 *   GET    /api/credit-notes/pending         órdenes canceladas con boleta y sin nota
 *   GET    /api/credit-notes/preview?retailer=&order=
 *   POST   /api/credit-notes/draft           crea el borrador en el Portal MIPYME
 *   POST   /api/credit-notes/register        anota una nota hecha fuera del ERP
 *   PATCH  /api/credit-notes/:id/confirm     { folio, issuedAt }  ya firmada en el portal
 *   DELETE /api/credit-notes/:id
 */
@Controller('credit-notes')
export class CreditNotesController {
  constructor(private readonly notes: CreditNotesService) {}

  @Get()
  list() {
    return this.notes.list();
  }

  @Get('pending')
  pending() {
    return this.notes.pending();
  }

  @Get('preview')
  preview(@Query('retailer') retailer: string, @Query('order') order: string) {
    if (!retailer || !order) return null;
    return this.notes.preview(retailer, order);
  }

  @Post('draft')
  @HttpCode(200)
  draft(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.notes.createDraft(validate(baseSchema, body), user?.id ?? null);
  }

  @Post('register')
  @HttpCode(200)
  register(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.notes.register(validate(registerSchema, body), user?.id ?? null);
  }

  @Patch(':id/confirm')
  confirm(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = validate(
      z.object({
        folio: z.string({ error: 'Falta el N° de la nota' }).trim().min(1, 'Falta el N° de la nota').max(30),
        issuedAt: dateSchema,
        notes: z.string().trim().max(500).nullish(),
      }),
      body,
    );
    return this.notes.confirm(id, data);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.notes.remove(id);
  }
}
