import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { ReportsService } from './reports.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Valida las fechas opcionales AAAA-MM-DD */
function checkDates(...dates: (string | undefined)[]) {
  for (const d of dates) {
    if (d && !ISO_DATE.test(d)) throw new BadRequestException(`Fecha inválida: "${d}" (usa AAAA-MM-DD)`);
  }
}

/**
 * Reportes.
 *   GET /api/reports/top-products?from=2026-10-01&to=2026-10-31   (fechas opcionales)
 *   GET /api/reports/dashboard?from=2026-10-01&to=2026-10-31      (fechas opcionales)
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('top-products')
  topProducts(@Query('from') from?: string, @Query('to') to?: string) {
    checkDates(from, to);
    return this.reports.topProducts(from || undefined, to || undefined);
  }

  @Get('dashboard')
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    checkDates(from, to);
    return this.dashboardService.dashboard(from || undefined, to || undefined);
  }
}