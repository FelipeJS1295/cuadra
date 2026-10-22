import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { ACCEPTED_EXTENSIONS } from '../common/excel-reader.js';
import { validate } from '../products/catalog.validation.js';
import { CatalogService } from './catalog.service.js';

interface UploadedExcel {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const MAX_FILE_SIZE_MB = 20;

const idsSchema = z
  .array(z.uuid({ error: 'Id inválido' }), { error: 'Faltan los productos (ids)' })
  .min(1, 'Selecciona al menos un producto');

const assignSchema = z.object({
  ids: idsSchema,
  /** null = quitar el master */
  productId: z.uuid({ error: 'Producto master inválido' }).nullable(),
});

const deleteSchema = z.object({ ids: idsSchema });

const manualSchema = z.object({
  retailerCode: z.string({ error: 'Falta el retailer' }).min(1),
  sellerSku: z.string().nullable().optional(),
  name: z.string({ error: 'Falta el nombre del producto' }).trim().min(1, 'Falta el nombre del producto').max(300),
  productId: z.uuid({ error: 'Elige un producto master' }),
});

/**
 * Catálogo de cada retailer y asignación de productos master.
 *   GET  /api/catalog/retailers           retailers con adaptador + conteos
 *   GET  /api/catalog?retailer=CENCOSUD   catálogo del retailer, con su master
 *   POST /api/catalog/import/CENCOSUD     carga el archivo (campo "file")
 *   POST /api/catalog/assign              { ids, productId | null }
 *   POST /api/catalog/delete              { ids }
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('retailers')
  retailers() {
    return this.catalog.availableRetailers();
  }

  @Get()
  list(@Query('retailer') retailer?: string) {
    if (!retailer) throw new BadRequestException('Falta el retailer (?retailer=CODIGO)');
    return this.catalog.list(retailer);
  }

  @Post('import/:retailerCode')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 } }))
  import(@Param('retailerCode') retailerCode: string, @UploadedFile() file: UploadedExcel | undefined) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    if (!ACCEPTED_EXTENSIONS.some((ext) => file.originalname.toLowerCase().endsWith(ext))) {
      throw new BadRequestException('Solo se aceptan archivos Excel (.xlsx) o CSV (.csv)');
    }
    return this.catalog.importFile(retailerCode, file.originalname, file.buffer);
  }

  @Post('assign')
  assign(@Body() body: unknown) {
    const { ids, productId } = validate(assignSchema, body);
    return this.catalog.assign(ids, productId);
  }

    /** Desde la conciliación: producto sin costo -> master */
  @Post('manual')
  manual(@Body() body: unknown) {
    const data = validate(manualSchema, body);
    return this.catalog.manualAssign({ ...data, sellerSku: data.sellerSku ?? null });
  }

  @Post('delete')
  remove(@Body() body: unknown) {
    const { ids } = validate(deleteSchema, body);
    return this.catalog.remove(ids);
  }
}