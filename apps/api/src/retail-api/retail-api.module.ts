import { Module } from '@nestjs/common';
import { RetailApiController } from './retail-api.controller.js';
import { RetailApiService } from './retail-api.service.js';

/** API Retail: sección aparte con ventas y productos traídos por API (no toca Ventas) */
@Module({
  controllers: [RetailApiController],
  providers: [RetailApiService],
  // Sii lo usa para subir las boletas al portal del retailer (Paris)
  exports: [RetailApiService],
})
export class RetailApiModule {}
