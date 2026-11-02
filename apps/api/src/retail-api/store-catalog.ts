/**
 * Productos de Cuadra para la tienda web: se juntan los productos de los retailers por su
 * SKU padre/color (o por el SKU del vendedor si no tiene) y se sacan sus fotos y descripción.
 */

const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
const IMG_KEY = /^(mainimage|image|images|imageurl|image_url|img|picture|pictures|media|medias|src|secure_url|url|link|thumbnail)$/i;

/** Fotos dentro de la respuesta del retailer (cualquiera sea su formato), en orden */
export function extractImages(raw: unknown, first?: string | null): string[] {
  const found: { url: string; pos: number; order: number }[] = [];
  let order = 0;
  const walk = (v: unknown, key: string, depth: number, pos: number | null) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^https?:\/\//i.test(s) && (IMG_EXT.test(s) || (IMG_KEY.test(key) && /image|img|media|photo|foto|picture|static/i.test(s)))) {
        found.push({ url: s, pos: pos ?? 999, order: order++ });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, key, depth + 1, pos ?? null));
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const p = typeof o.position === 'number' ? o.position : typeof o.Position === 'number' ? o.Position : pos;
      for (const [k, x] of Object.entries(o)) walk(x, k, depth + 1, p);
    }
  };
  walk(raw, '', 0, null);
  // Mercado Libre trae "url" (http) y "secure_url" (https) de la misma foto; y las miniaturas
  const isThumb = (u: string) => /[-_](I|O|S|thumb|thumbnail|small)\.(jpe?g|webp|png)/i.test(u) && /mlstatic/i.test(u);
  const urls = found
    .filter((f) => !isThumb(f.url))
    .sort((a, b) => a.pos - b.pos || a.order - b.order)
    .map((f) => f.url);
  // La misma foto puede venir en http y https: se deja una sola (la tienda la descarga desde su servidor)
  const seen = new Set<string>();
  return [first, ...urls]
    .filter((x): x is string => Boolean(x))
    .filter((u) => {
      const k = u.replace(/^https?:\/\//i, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** HTML de la descripción del retailer → texto con saltos de línea */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&([a-z])acute;/gi, (_m, c: string) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' })[c] ?? c)
    .replace(/&ntilde;/g, 'ñ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** Orden de preferencia para tomar fotos y textos (el que mejor ficha suele tener primero) */
export const SOURCE_ORDER = ['CENCOSUD', 'FALABELLA', 'MERCADOLIBRE', 'RIPLEY', 'WALMART'];
