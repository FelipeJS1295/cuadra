import { Module } from '@nestjs/common';
import { PurchasesModule } from '../purchases/purchases.module.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SettlementsController } from './settlements.controller.js';
import { SettlementsService } from './settlements.service.js';

@Module({
  // La conciliación muestra los documentos de compra de cada orden
  imports: [PurchasesModule],
  controllers: [SettlementsController],
  providers: [SettlementsService, ReconciliationService],
  // El dashboard (módulo de reportes) usa la conciliación
  exports: [SettlementsService, ReconciliationService],
})
export class SettlementsModule {}