import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { AccountingController } from './accounting.controller.js';
import { ReceivablesService } from './receivables.service.js';
import { VatService } from './vat.service.js';

@Module({
  imports: [SalesModule],
  controllers: [AccountingController],
  providers: [ReceivablesService, VatService],
  exports: [ReceivablesService, VatService],
})
export class AccountingModule {}
