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
import { SalesIngestionService } from './sales-ingestion.service.js';


/** Datos del archivo subido que entrega Nest (multer) */
interface UploadedExcel {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const MAX_FILE_SIZE_MB = 20;

@Controller('sales/import')
export class SalesIngestionController {
  constructor(private readonly ingestion: SalesIngestionService) {}

  /** GET /api/sales/import/retailers — retailers cuyos archivos se pueden cargar */
  @Get('retailers')
  retailers() {
    return this.ingestion.availableRetailers();
  }

  /**
   * POST /api/sales/import/FALABELLA
   * Body: multipart/form-data con el archivo en el campo "file"
   */
  @Post(':retailerCode')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 } }),
  )
  async import(
    @Param('retailerCode') retailerCode: string,
    @UploadedFile() file: UploadedExcel | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Falta el archivo (campo "file")');
    }
    if (!ACCEPTED_EXTENSIONS.some((ext) => file.originalname.toLowerCase().endsWith(ext))) {
      throw new BadRequestException('Solo se aceptan archivos Excel (.xlsx) o CSV (.csv)');
    }
    return this.ingestion.importFile(retailerCode, file.originalname, file.buffer);
  }
}