import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

/** Una fila del archivo: { "Nombre de columna": valor } */
export type ExcelRow = Record<string, unknown>;

/** Cuántas filas de arriba se revisan buscando los encabezados */
const MAX_HEADER_SEARCH = 30;

/** Formatos aceptados para subir archivos */
export const ACCEPTED_EXTENSIONS = ['.xlsx', '.csv'];

/**
 * Lee un archivo de retailer (Excel .xlsx o CSV) y busca sola la fila de encabezados:
 * la primera fila (dentro de las primeras 30) que contenga TODAS las columnas obligatorias.
 * Sirve para reportes que traen títulos, fechas o avisos arriba de la tabla.
 *
 * - Excel: se lee la primera hoja.
 * - CSV: se detecta solo si viene separado por ";" o "," y se ignora la marca BOM.
 * - Los nombres de columna se limpian de espacios (" N° Documento " -> "N° Documento").
 * - Las columnas repetidas se renombran: "Comuna", "Comuna (2)"...
 * - Si no encuentra los encabezados, rechaza el archivo indicando qué columnas faltan.
 */
export async function readExcelTable(
  buffer: Buffer,
  requiredHeaders: string[],
  retailerName: string,
  fileName = '',
) {
  const sheets = fileName.toLowerCase().endsWith('.csv') ? [readCsv(buffer)] : await readXlsx(buffer);

  if (!sheets.some((grid) => grid.length >= 2)) {
    throw new BadRequestException('El archivo está vacío o no tiene filas de datos');
  }

  // 1. Buscar la fila de encabezados, hoja por hoja (la primera que calce gana)
  let grid: unknown[][] = [];
  let headerIndex = -1;
  let headers: string[] = [];
  let bestMissing = requiredHeaders;

  for (const sheet of sheets) {
    for (let i = 0; i < Math.min(MAX_HEADER_SEARCH, sheet.length); i++) {
      const candidate = buildHeaders(sheet[i]);
      const missing = requiredHeaders.filter((h) => !candidate.includes(h));
      if (missing.length === 0) {
        grid = sheet;
        headerIndex = i;
        headers = candidate;
        break;
      }
      if (missing.length < bestMissing.length) bestMissing = missing;
    }
    if (headerIndex >= 0) break;
  }

  if (headerIndex < 0) {
    throw new BadRequestException(
      `El archivo no parece de ${retailerName}. Faltan las columnas: ${bestMissing.join(', ')}`,
    );
  }

  // 2. Las filas de datos que vienen debajo (se ignoran las completamente vacías)
  const rows: { rowNumber: number; values: ExcelRow }[] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const values: ExcelRow = {};
    let hasData = false;
    headers.forEach((header, col) => {
      if (!header) return;
      const value = grid[i][col] ?? null;
      values[header] = value;
      if (value !== null && value !== '') hasData = true;
    });
    if (hasData) rows.push({ rowNumber: i + 1, values });
  }

  return { headers, rows, headerRowNumber: headerIndex + 1 };
}

/** Excel -> una tabla de valores (fila x columna) por cada hoja, en orden */
async function readXlsx(buffer: Buffer): Promise<unknown[][][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('No se pudo leer el archivo. ¿Es un Excel .xlsx válido?');
  }
  return workbook.worksheets.map((sheet) => {
    const grid: unknown[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cellValue(cell.value);
      });
      grid[rowNumber - 1] = values;
    });
    // eachRow se salta filas vacías: se rellenan para mantener los números de fila reales
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    return grid;
  });
}

/** CSV -> tabla de valores. Detecta el separador mirando la primera línea */
function readCsv(buffer: Buffer): unknown[][] {
  // La mayoría viene en UTF-8; algunos (ej: Walmart) en Windows-1252 / Latin-1.
  // Si al leer como UTF-8 aparecen caracteres inválidos (�), se relee como Windows-1252.
  let text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buffer);
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  try {
    return parse(text, {
      delimiter,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
    }) as unknown[][];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BadRequestException(`No se pudo leer el CSV: ${reason}`);
  }
}

function buildHeaders(row: unknown[]): string[] {
  const headers: string[] = [];
  const seen = new Map<string, number>();
  row.forEach((value, col) => {
    // Se limpian espacios al inicio, al final y dobles ("Tipo  / Type" -> "Tipo / Type")
    const name = String(value ?? '').replace(/\s+/g, ' ').trim();
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    headers[col] = name && count > 1 ? `${name} (${count})` : name;
  });
  return headers;
}

/**
 * ExcelJS puede devolver objetos en vez de valores simples
 * (texto enriquecido, fórmulas, hipervínculos). Esto los aplana.
 */
export function cellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
    if ('text' in value) return value.text;
    if ('error' in value) return null;
  }
  return value;
}