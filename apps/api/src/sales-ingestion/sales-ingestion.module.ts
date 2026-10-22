import { Module } from '@nestjs/common';
import { SalesIngestionController } from './sales-ingestion.controller.js';
import { SalesIngestionService } from './sales-ingestion.service.js';

@Module({
  controllers: [SalesIngestionController],
  providers: [SalesIngestionService],
})
export class SalesIngestionModule {}