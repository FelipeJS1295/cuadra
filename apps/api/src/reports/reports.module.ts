import { Module } from '@nestjs/common';
import { SettlementsModule } from '../settlements/settlements.module.js';
import { DashboardService } from './dashboard.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [SettlementsModule],
  controllers: [ReportsController],
  providers: [ReportsService, DashboardService],
})
export class ReportsModule {}