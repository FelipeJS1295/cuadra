import { Module } from '@nestjs/common';
import { SettlementsModule } from '../settlements/settlements.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  // Los montos de liquidación y factura del proveedor salen de la conciliación
  imports: [SettlementsModule],
  controllers: [SalesController],
  providers: [SalesService],
  // La usan la emisión de boletas (SII) y la API externa
  exports: [SalesService],
})
export class SalesModule {}