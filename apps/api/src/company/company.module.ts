import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { SiiModule } from '../sii/sii.module.js';
import { CompanyController } from './company.controller.js';
import { HomeService } from './home.service.js';

@Module({
  imports: [SalesModule, AccountingModule, SiiModule],
  controllers: [CompanyController],
  providers: [HomeService],
})
export class CompanyModule {}
