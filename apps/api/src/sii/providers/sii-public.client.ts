import { Injectable, Logger } from '@nestjs/common';

/**
 * Consulta pública del SII "Situación tributaria de terceros" (zeus.sii.cl/cvc_cgi/stc):
 * razón social y actividades económicas (giros) de un RUT. No necesita clave.
 * El SII pide un captcha que viene resuelto en su propia respuesta (CViewCaptcha).
 * No entrega la dirección.
 */
@Injectable()
export class SiiPublicClient {
  private readonly logger = new Logger(SiiPublicClient.name);
  private readonly base = (process.env.SII_STC_URL || 'https://zeus.sii.cl/cvc_cgi/stc').replace(/\/+$/, '');
  private readonly cache = new Map<string, { at: number; data: { razonSocial: string | null; actividades: { codigo: string; glosa: string }[] } }>();

  async contribuyente(rut: string): Promise<{ razonSocial: string | null; actividades: { codigo: string; glosa: string }[] }> {
    const clean = rut.replace(/[.\s]/g, '').toUpperCase();
    const m = /^(\d{1,9})-([\dK])$/.exec(clean);
    if (!m) throw new Error('RUT inválido');
    const hit = this.cache.get(clean);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.data;

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Cuadra ERP)' };
    const cap = await fetch(`${this.base}/CViewCaptcha.cgi`, { method: 'POST', headers, body: 'oper=0', signal: AbortSignal.timeout(20000) });
    if (!cap.ok) throw new Error(`El SII respondió ${cap.status} al pedir el captcha`);
    const { txtCaptcha } = (await cap.json()) as { txtCaptcha?: string };
    if (!txtCaptcha) throw new Error('El SII no entregó el captcha');
    // El código va dentro del mismo captcha (posiciones 36 a 39 del texto decodificado)
    const code = Buffer.from(txtCaptcha, 'base64').toString('latin1').slice(36, 40);

    const body = new URLSearchParams({ RUT: m[1], DV: m[2], PRG: 'STC', OPC: 'NOR', txt_code: code, txt_captcha: txtCaptcha });
    const res = await fetch(`${this.base}/getstc`, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`El SII respondió ${res.status}`);
    const html = new TextDecoder('latin1').decode(await res.arrayBuffer());
    const data = parse(html);
    if (!data.razonSocial && !data.actividades.length) {
      this.logger.warn(`SII STC sin datos para ${clean}: ${html.replace(/\s+/g, ' ').slice(0, 200)}`);
      throw new Error('El SII no entregó datos para ese RUT');
    }
    this.cache.set(clean, { at: Date.now(), data });
    return data;
  }
}

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&oacute;/g, 'ó')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();

/** Razón social (el div que sigue a "Nombre o Razón Social") y la tabla de actividades */
function parse(html: string) {
  let razonSocial: string | null = null;
  const name = /Raz(?:[oó]|&oacute;)n\s+Social[\s\S]{0,80}?<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (name) razonSocial = text(name[1]) || null;

  const actividades: { codigo: string; glosa: string }[] = [];
  // Cada fila: glosa, código (6 dígitos), categoría, afecta IVA, fecha
  const row = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*(\d{5,6})\s*(?:<\/font>)?\s*<\/td>/gi;
  for (let m = row.exec(html); m; m = row.exec(html)) {
    const glosa = text(m[1]);
    if (glosa && !/actividades/i.test(glosa)) actividades.push({ codigo: m[2], glosa });
  }
  return { razonSocial, actividades };
}
