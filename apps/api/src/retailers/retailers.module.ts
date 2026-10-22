import { Module } from '@nestjs/common';
import { RetailersController } from './retailers.controller.js';

@Module({ controllers: [RetailersController] })
export class RetailersModule {}
