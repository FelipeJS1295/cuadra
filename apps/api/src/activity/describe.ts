/** Nombres legibles de cada retailer en la actividad */
const RETAILERS: Record<string, string> = {
  FALABELLA: 'Falabella',
  CENCOSUD: 'Paris',
  WALMART: 'Walmart',
  RIPLEY: 'Ripley',
  MERCADOLIBRE: 'Mercado Libre',
  HITES: 'Hites',
};
const r = (code?: string) => (code ? (RETAILERS[code.toUpperCase()] ?? code) : '');

/** Pedidos que no se anotan (ruido: vistas previas, avisos leídos, la propia actividad) */
export const IGNORED = new Set([
  'POST /api/activity/page',
  'POST /api/returns/lookup-text',
  'POST /api/sii/mipyme/facturas/lote/preview',
  'POST /api/b2b/notifications/read',
  'POST /api/b2b/refresh',
  'POST /api/auth/login',
  'POST /api/auth/signup',
  // Se anota aparte, con el correo del usuario
  'POST /api/admin/users/:id/password',
]);

type P = Record<string, string | undefined>;
const ACTIONS: Record<string, (p: P) => string> = {
  'POST /api/auth/logout': () => 'Cerró sesión',
  'POST /api/auth/switch': () => 'Cambió de empresa',
  'POST /api/auth/change-password': () => 'Cambió su contraseña',
  'POST /api/auth/tenants': () => 'Creó una empresa',

  'POST /api/retail-api/:provider/orders/sync': (p) => `Actualizó ventas de ${r(p.provider)}`,
  'POST /api/retail-api/:provider/products/sync': (p) => `Actualizó productos de ${r(p.provider)}`,
  'POST /api/retail-api/:provider/products/update': (p) => `Modificó un producto en ${r(p.provider)}`,
  'PUT /api/retail-api/connections/:provider': (p) => `Guardó la conexión de ${r(p.provider)}`,
  'POST /api/retail-api/connections/:provider/test': (p) => `Probó la conexión de ${r(p.provider)}`,
  'DELETE /api/retail-api/connections/:provider': (p) => `Desconectó ${r(p.provider)}`,
  'PUT /api/retail-api/:provider/sku-names': (p) => `Asoció un SKU padre/color en ${r(p.provider)}`,
  'DELETE /api/retail-api/:provider/sku-names/:sku': (p) => `Quitó un SKU padre/color en ${r(p.provider)}`,
  'POST /api/retail-api/labels': () => 'Sacó etiquetas de despacho',
  'POST /api/retail-api/enviame/labels': () => 'Sacó etiquetas de Paris (Envíame)',
  'POST /api/retail-api/enviame/pickups': () => 'Agendó un retiro en Envíame',

  'POST /api/sales/import/:retailerCode': (p) => `Subió ventas de ${r(p.retailerCode)}`,
  'POST /api/settlements/import/:retailerCode': (p) => `Subió una liquidación de ${r(p.retailerCode)}`,
  'POST /api/catalog/import/:retailerCode': (p) => `Subió el catálogo de ${r(p.retailerCode)}`,
  'POST /api/catalog/assign': () => 'Asoció productos del catálogo',
  'POST /api/catalog/manual': () => 'Agregó un producto al catálogo',
  'POST /api/catalog/delete': () => 'Borró productos del catálogo',
  'POST /api/sales/receipts': () => 'Anotó una boleta',
  'DELETE /api/sales/receipts/:id': () => 'Borró una boleta anotada',

  'POST /api/sii/boletas': () => 'Emitió una boleta',
  'POST /api/sii/boletas/lote': () => 'Emitió boletas en lote',
  'POST /api/sii/boletas/:id/enviar-retail': () => 'Envió una boleta al retail',
  'POST /api/sii/boletas/enviar-retail-pendientes': () => 'Envió las boletas pendientes a los retail',
  'POST /api/sii/mipyme/facturas': () => 'Emitió una factura',
  'POST /api/sii/mipyme/facturas/lote': () => 'Emitió una factura de varias ventas',
  'DELETE /api/sii/mipyme/facturas/:id': () => 'Borró un borrador de factura',
  'POST /api/sii/mipyme/guias': () => 'Creó una guía de despacho',
  'PATCH /api/sii/mipyme/guias/:id/folio': () => 'Anotó el folio de una guía',
  'DELETE /api/sii/mipyme/guias/:id': () => 'Borró una guía de despacho',
  'POST /api/sii/mipyme/sincronizar': () => 'Sincronizó con el SII',
  'POST /api/sii/compras/importar': () => 'Trajo las compras del SII',
  'POST /api/credit-notes/draft': () => 'Preparó una nota de crédito',
  'POST /api/credit-notes/register': () => 'Anotó una nota de crédito',
  'PATCH /api/credit-notes/:id/confirm': () => 'Confirmó una nota de crédito',
  'DELETE /api/credit-notes/:id': () => 'Borró una nota de crédito',

  'POST /api/purchases/documents': () => 'Subió documentos de compra',
  'PATCH /api/purchases/invoices/:id': () => 'Editó una factura de compra',
  'POST /api/purchases/invoices/:id/payments': () => 'Anotó un pago a proveedor',
  'DELETE /api/purchases/payments/:id': () => 'Borró un pago a proveedor',
  'DELETE /api/purchases/lines/:id': () => 'Quitó una línea de compra',

  'POST /api/products': () => 'Creó un producto',
  'PATCH /api/products/:id': () => 'Editó un producto',
  'DELETE /api/products/:id': () => 'Borró un producto',
  'PUT /api/products/:id/receta': () => 'Editó la receta de un producto',
  'POST /api/supplies': () => 'Creó un insumo',
  'PATCH /api/supplies/:id': () => 'Editó un insumo',
  'DELETE /api/supplies/:id': () => 'Borró un insumo',

  'POST /api/returns': () => 'Registró una devolución',
  'POST /api/returns/receive': () => 'Recibió una devolución en bodega',
  'PATCH /api/returns/:id': () => 'Editó una devolución',
  'DELETE /api/returns/:id': () => 'Borró una devolución',

  'POST /api/b2b/send': () => 'Envió ventas al proveedor',
  'PATCH /api/b2b/client-products/:id': () => 'Editó un producto de cliente',
  'PATCH /api/retailers/:id': () => 'Editó las condiciones de un retailer',

  'PATCH /api/company': () => 'Editó los datos de la empresa',
  'PUT /api/company/sii': () => 'Guardó la conexión al SII',
  'POST /api/company/sii/test': () => 'Probó la conexión al SII',
  'POST /api/company/onboarding/:step': () => 'Avanzó en la bienvenida',
  'POST /api/team': () => 'Invitó a un usuario',
  'PATCH /api/team/:id': () => 'Cambió un usuario del equipo',
  'DELETE /api/team/:id': () => 'Quitó un usuario del equipo',

  'PATCH /api/admin/tenants/:id': () => 'Admin: cambió una empresa',
  'POST /api/admin/tenants/:id/enter': () => 'Admin: entró a una empresa',
  'POST /api/admin/users/:id/password': () => 'Admin: cambió la clave de un usuario',
};

/** "Subió ventas de Falabella" a partir de la ruta y sus parámetros */
export function describeAction(method: string, route: string, params: P): string {
  const f = ACTIONS[`${method} ${route}`];
  return f ? f(params) : `${method} ${route.replace(/^\/api/, '')}`;
}

/** Nombre de cada página de la web */
const PAGES: Record<string, string> = {
  '/': 'Inicio',
  '/ventas': 'Ventas',
  '/devoluciones': 'Devoluciones',
  '/cobros': 'Cobros',
  '/compras': 'Compras',
  '/impuestos': 'Impuestos',
  '/productos': 'Productos',
  '/configuracion': 'Configuración',
  '/conexiones': 'Conexiones',
  '/bienvenida': 'Bienvenida',
  '/admin': 'Administración',
};
export function describePage(path: string) {
  const [p, q] = path.split('?');
  const name = PAGES[p.replace(/\/+$/, '') || '/'] ?? p;
  const tab = new URLSearchParams(q ?? '').get('tab');
  return `Abrió ${name}${tab ? ` (${tab})` : ''}`;
}
