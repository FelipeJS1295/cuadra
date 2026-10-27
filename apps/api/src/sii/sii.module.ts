import { Module } from '@nestjs/common';
import { RetailApiModule } from '../retail-api/retail-api.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { SettlementsModule } from '../settlements/settlements.module.js';
import { GuidesService } from './guides.service.js';
import { MipymeController } from './mipyme.controller.js';
import { MipymeService } from './mipyme.service.js';
import { PurchaseDocsService } from './purchase-docs.service.js';
import { ApiGatewayClient } from './api-gateway.client.js';
import { CreditNotesController } from './credit-notes.controller.js';
import { CreditNotesService } from './credit-notes.service.js';
import { PurchasesImportController } from './purchases-import.controller.js';
import { PurchasesImportService } from './purchases-import.service.js';
import { SiiController } from './sii.controller.js';
import { SiiService } from './sii.service.js';
import { SiiProviderService } from './sii-provider.service.js';
import { NuboxClient } from './providers/nubox.client.js';
import { NuboxClassicClient } from './providers/nubox-classic.client.js';
import { SiiPortalClient } from './providers/sii-portal.client.js';
import { SimpleApiClient } from './providers/simpleapi.client.js';

@Module({
  // Los datos del cliente y los montos de la orden salen de Ventas
  imports: [SalesModule, SettlementsModule, RetailApiModule],
  controllers: [SiiController, CreditNotesController, PurchasesImportController, MipymeController],
  providers: [SiiService, ApiGatewayClient, SimpleApiClient, NuboxClient, NuboxClassicClient, SiiPortalClient, SiiProviderService, CreditNotesService, PurchasesImportService, MipymeService, GuidesService, PurchaseDocsService],
  exports: [CreditNotesService, ApiGatewayClient, SiiProviderService],
})
export class SiiModule {}
