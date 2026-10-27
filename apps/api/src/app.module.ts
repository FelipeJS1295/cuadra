import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { B2bModule } from './b2b/b2b.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CompanyModule } from './company/company.module.js';
import { SettingsModule } from './company/settings.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { ProductsModule } from './products/products.module.js';
import { PurchasesModule } from './purchases/purchases.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { RetailApiModule } from './retail-api/retail-api.module.js';
import { RetailersModule } from './retailers/retailers.module.js';
import { ReturnsModule } from './returns/returns.module.js';
import { SalesIngestionModule } from './sales-ingestion/sales-ingestion.module.js';
import { SalesModule } from './sales/sales.module.js';
import { SettlementsModule } from './settlements/settlements.module.js';
import { SiiModule } from './sii/sii.module.js';

@Module({
  imports: [
    // Variables desde .env (primero el de la app, luego el de la raíz)
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    DatabaseModule,
    SettingsModule,
    AuthModule,
    AdminModule,
    CompanyModule,
    HealthModule,
    ProductsModule,
    PurchasesModule,
    ReportsModule,
    SalesIngestionModule,
    SalesModule,
    SettlementsModule,
    SiiModule,
    AccountingModule,
    RetailersModule,
    ReturnsModule,
    RetailApiModule,
    CatalogModule,
    B2bModule,
  ],
})
export class AppModule {}
