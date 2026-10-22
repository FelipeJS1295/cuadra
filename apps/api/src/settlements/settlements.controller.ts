import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ACCEPTED_EXTENSIONS } from '../common/excel-reader.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SettlementsService } from './settlements.service.js';


interface UploadedExcel {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const MAX_FILE_SIZE_MB = 20;

@Controller()
export class SettlementsController {
  constructor(
    private readonly settlements: SettlementsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** GET /api/settlements/import/retailers — retailers cuya liquidación se puede cargar */
  @Get('settlements/import/retailers')
  retailers() {
    return this.settlements.availableRetailers();
  }

  /** POST /api/settlements/import/FALABELLA — multipart con el archivo en "file" */
  @Post('settlements/import/:retailerCode')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 } }),
  )
  async import(
    @Param('retailerCode') retailerCode: string,
    @UploadedFile() file: UploadedExcel | undefined,
  ) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    if (!ACCEPTED_EXTENSIONS.some((ext) => file.originalname.toLowerCase().endsWith(ext))) {
      throw new BadRequestException('Solo se aceptan archivos Excel (.xlsx) o CSV (.csv)');
    }
    return this.settlements.importFile(retailerCode, file.originalname, file.buffer);
  }

  /** GET /api/reconciliation/FALABELLA — cruce de ventas vs liquidación */
  @Get('reconciliation/:retailerCode')
  reconcile(@Param('retailerCode') retailerCode: string) {
    return this.reconciliation.reconcile(retailerCode);
  }
}