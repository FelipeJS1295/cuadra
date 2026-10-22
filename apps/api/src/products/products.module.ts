import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { SuppliesController } from './supplies.controller.js';

@Module({
  controllers: [ProductsController, SuppliesController],
  providers: [ProductsService],
})
export class ProductsModule {}