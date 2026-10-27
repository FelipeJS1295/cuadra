import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type SessionUser } from '../auth/decorators.js';
import { validate } from '../products/catalog.validation.js';
import { B2bService } from './b2b.service.js';

/**
 * Ventas entre empresas de Cuadra (cliente -> proveedor) y avisos.
 *   GET   /api/b2b/suppliers                       mis proveedores y cuáles tienen cuenta en Cuadra
 *   POST  /api/b2b/send { supplierId, orders }     envía ventas al proveedor (sin montos ni datos del cliente final)
 *   GET   /api/b2b/client-products                 (proveedor) productos que llegaron de sus clientes
 *   PATCH /api/b2b/client-products/:id             (proveedor) precio, SKU padre/color, nombre, producto
 *   GET   /api/b2b/notifications                   avisos de la empresa
 *   POST  /api/b2b/notifications/read { ids? }     marcar leídos (sin ids: todos)
 */
@Controller('b2b')
export class B2bController {
  constructor(private readonly b2b: B2bService) {}

  @Get('suppliers')
  suppliers() {
    return this.b2b.suppliers();
  }

  @Post('send')
  @HttpCode(200)
  send(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const input = validate(
      z.object({
        supplierId: z.string().uuid('Elige el proveedor'),
        orders: z
          .array(z.object({ retailerCode: z.string().min(1).max(30), orderNumber: z.string().min(1).max(60) }))
          .min(1, 'Elige al menos una venta')
          .max(500, 'Máximo 500 ventas por envío'),
      }),
      body,
    );
    return this.b2b.send(input.supplierId, input.orders, user.name || user.email);
  }

  @Get('client-products')
  clientProducts() {
    return this.b2b.clientProducts();
  }

  @Patch('client-products/:id')
  updateClientProduct(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const input = validate(
      z
        .object({
          price: z.number().min(0).max(100000000).nullable().optional(),
          parentSku: z
            .string()
            .trim()
            .max(80)
            .regex(/^[A-Za-z0-9._\-/ ]*$/, 'El SKU padre/color solo puede tener letras, números, guion, punto o barra')
            .nullable()
            .optional(),
          name: z.string().trim().max(300).nullable().optional(),
          productId: z.string().uuid().nullable().optional(),
        })
        .strict(),
      body,
    );
    return this.b2b.updateClientProduct(id, input, user.name || user.email);
  }

  /** (proveedor) Clientes de Cuadra que le envían ventas */
  @Get('clients')
  clients() {
    return this.b2b.clients();
  }

  /** (proveedor) Actualiza las ventas ya recibidas de clientes: estado, despacho, courier, cantidad */
  @Post('refresh')
  @HttpCode(200)
  refresh() {
    return this.b2b.refreshFromClients();
  }

  @Get('notifications')
  notifications() {
    return this.b2b.notifications();
  }

  // Marcar como leído también lo puede hacer un usuario de solo lectura
  @Post('notifications/read')
  @Roles('DUENO', 'ADMIN', 'OPERADOR', 'LECTURA')
  @HttpCode(200)
  read(@Body() body: unknown) {
    const { ids } = validate(z.object({ ids: z.array(z.string().uuid()).max(100).optional() }), body ?? {});
    return this.b2b.markRead(ids);
  }
}
