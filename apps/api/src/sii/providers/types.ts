/** Proveedores de conexión con el SII que puede elegir cada empresa */
export const SII_PROVIDERS = ['APIGATEWAY', 'SIMPLEAPI', 'NUBOX'] as const;
export type SiiProviderKind = (typeof SII_PROVIDERS)[number];

/** Lo que Cuadra puede hacer con el SII (cada proveedor permite una parte) */
export interface SiiCapabilities {
  /** Emitir boletas desde Ventas */
  boletas: boolean;
  /** Notas de crédito desde el sistema */
  notasCredito: boolean;
  /** true: la nota queda emitida al tiro · false: queda como borrador que se firma en el portal del SII */
  notasCreditoDirectas: boolean;
  /** Traer facturas de proveedores (Registro de Compras) */
  compras: boolean;
  /** PDF y productos de las facturas de proveedores */
  comprasDetalle: boolean;
  /** Comparar lo emitido con el Registro de Ventas */
  cuadratura: boolean;
  /** Facturas de venta (33) y guías de despacho (52) como borrador en el Portal MIPYME */
  facturasYGuias: boolean;
}

export const PROVIDER_NAMES: Record<SiiProviderKind, string> = {
  APIGATEWAY: 'API Gateway',
  SIMPLEAPI: 'SimpleAPI',
  NUBOX: 'Nubox',
};

export const CAPABILITIES: Record<SiiProviderKind, SiiCapabilities> = {
  APIGATEWAY: {
    boletas: true,
    notasCredito: true,
    notasCreditoDirectas: false,
    compras: true,
    comprasDetalle: true,
    cuadratura: true,
    facturasYGuias: true,
  },
  // SimpleAPI-RCV: lee el Registro de Compras y Ventas con la clave del SII.
  // (Emitir con SimpleAPI-DTE exige certificado digital y folios CAF propios: no incluido.)
  SIMPLEAPI: {
    boletas: false,
    notasCredito: false,
    notasCreditoDirectas: false,
    compras: true,
    comprasDetalle: false,
    cuadratura: true,
    facturasYGuias: false,
  },
  // Nubox (API de Integraciones de Factura y Administración): emite y lista ventas.
  // Su API nueva no lista compras.
  NUBOX: {
    boletas: true,
    notasCredito: true,
    notasCreditoDirectas: true,
    compras: false,
    comprasDetalle: false,
    cuadratura: true,
    facturasYGuias: false,
  },
};

/** Resultado de emitir un documento */
export interface IssuedDoc {
  folio: number;
  dte: number;
  pdfUrl: string | null;
  pdfBase64: string | null;
  raw: unknown;
}

/** Fila del resumen del Registro de Ventas, igual para todos los proveedores */
export interface SalesSummaryRow {
  tipodoc: number;
  nombretipodoc: string;
  totaldocumentos: number;
  montototal: number;
  montoiva: number;
}
