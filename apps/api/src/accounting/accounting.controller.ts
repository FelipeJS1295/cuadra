import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReceivablesService } from './receivables.service.js';
import { VatService } from './vat.service.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 *   GET /api/receivables              cuentas por cobrar a los retailers
 *   GET /api/vat?months=12            resumen de IVA por mes
 *   GET /api/vat/:month               documentos del mes (AAAA-MM)
 *   GET /api/vat/:month/csv           detalle del mes en CSV
 */
@Controller()
export class AccountingController {
  constructor(
    private readonly receivables: ReceivablesService,
    private readonly vat: VatService,
  ) {}

  @Get('receivables')
  getReceivables() {
    return this.receivables.get();
  }

  @Get('vat')
  vatMonths(@Query('months') months?: string) {
    return this.vat.months(Math.min(36, Math.max(1, Number(months) || 12)));
  }

  @Get('vat/:month')
  vatDetail(@Param('month') month: string) {
    if (!MONTH.test(month)) throw new BadRequestException('El mes debe tener formato AAAA-MM');
    return this.vat.detail(month);
  }

  @Get('vat/:month/csv')
  async vatCsv(@Param('month') month: string, @Res() res: Response) {
    if (!MONTH.test(month)) throw new BadRequestException('El mes debe tener formato AAAA-MM');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iva-${month}.csv"`);
    res.send(await this.vat.csv(month));
  }
}
