import type { FacturaReceptor, InvoiceLine } from './mipyme.service.js';

/**
 * Archivo para "Importar ventas electrónicas" de Nubox (plantilla VentasElectronicas.csv):
 * separado por ";", en Windows-1252 y con el mismo encabezado de la plantilla.
 * Una fila por línea de la factura; las filas con el mismo FOLIO forman un documento.
 */
const HEADER =
  '"TIPO (33: Factura electrónica, 34:Factura exenta electrónica, 56: Nota débito electrónica, 61:Nota de crédito electrónica, 39: Boleta electrónica; 41: Boleta exenta electrónica )";FOLIO;SECUENCIA;FECHA;RUT;RAZONSOCIAL;GIRO;COMUNA;DIRECCION;AFECTO;PRODUCTO;DESCRIPCION;CANTIDAD;PRECIO;PORCENTDSCTO;EMAIL;"TIPOSERVICIO (1: Boletas de servicios periódico ó Facturas de servicios periódicos domiciliarios; 2:Boletas de servicios periódicos domiciliarios ó Facturas de otros servicios periódicos; 3:Boletas de venta y servicios ó Factura de servicios)";PERIODODESDE;PERIODOHASTA;FECHAVENCIMIENTO';

/** Texto seguro para la celda: sin ";" ni saltos de línea, y solo caracteres que existen en Windows-1252 */
function cell(v: string | number | null | undefined, max = 0) {
  let s = String(v ?? '')
    .replace(/[\r\n\t;]+/g, ' ')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„"]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFC')
    .replace(/[^\u0000-ÿ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
}

/** Descripción de la línea: la orden de compra y el retail donde se vendió ("OC 3254000013 - Falabella") */
export function nuboxDescription(l: InvoiceLine, max = 100) {
  return cell([`OC ${l.oc}`, l.origin].filter(Boolean).join(' - '), max);
}

const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/');
const rutPlain = (rut: string) => rut.replace(/\./g, '').toUpperCase();

/** Una factura por día de venta y retail (ej. 25/11 Walmart, 25/11 Paris), en orden */
export function nuboxGroups(lines: InvoiceLine[], fallbackDate: string) {
  const groups = new Map<string, { date: string; origin: string; lines: InvoiceLine[] }>();
  for (const l of lines) {
    const date = l.date || fallbackDate;
    const origin = l.origin || 'Sin retail';
    const k = `${date}|${origin}`;
    if (!groups.has(k)) groups.set(k, { date, origin, lines: [] });
    groups.get(k)!.lines.push(l);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.origin.localeCompare(b.origin, 'es'));
}

export function nuboxSalesFile(opts: {
  lines: InvoiceLine[];
  receptor: FacturaReceptor;
  client: string;
  /** Folio de la primera factura; las siguientes son correlativas */
  folio: number;
  /** Fecha para todas las facturas; null = la fecha de las ventas de cada factura */
  fecha: string | null;
}) {
  const rows: string[] = [HEADER];
  const r = opts.receptor;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  let folio = opts.folio;
  const folios: { folio: number; date: string; origin: string; orders: string[]; net: number }[] = [];
  for (const g of nuboxGroups(opts.lines, today)) {
    const date = opts.fecha ?? g.date;
    g.lines.forEach((l, i) => {
      rows.push(
        [
          33,
          folio,
          i + 1,
          ddmmyyyy(date),
          rutPlain(r.rut),
          cell(r.name, 100),
          cell(r.activity, 40),
          cell(r.commune, 20),
          cell(r.address, 70),
          'SI',
          // PRODUCTO: el nombre del producto (máx. 80, como el nombre del ítem en el SII)
          cell(l.name, 80),
          nuboxDescription(l),
          l.quantity,
          l.unitNet ?? 0,
          0,
          '',
          '',
          '',
          '',
          '',
        ].join(';'),
      );
    });
    folios.push({ folio, date, origin: g.origin, orders: [...new Set(g.lines.map((l) => l.orderNumber))], net: g.lines.reduce((n, l) => n + l.net, 0) });
    folio++;
  }
  // Windows-1252: los caracteres ya quedaron dentro de Latin-1, que coincide en letras con tilde, ñ, °…
  return { buffer: Buffer.from(rows.join('\r\n') + '\r\n', 'latin1'), folios };
}
