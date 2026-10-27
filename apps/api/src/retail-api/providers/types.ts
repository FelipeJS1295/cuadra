/** Contrato común de los conectores de API Retail */

export interface ProviderConfig {
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export interface FieldDef {
  key: string;
  label: string;
  /** Se guarda cifrado y nunca vuelve completo al navegador */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Valor por defecto (ej: URL base) */
  default?: string;
}

export interface NormalizedItem {
  externalItemId: string;
  sellerSku: string | null;
  retailerSku: string | null;
  name: string | null;
  quantity: number;
  /** Con IVA */
  unitPrice: number | null;
  paidPrice: number | null;
  shippingAmount: number | null;
  status: string | null;
  /**
   * N° de la sub-orden a la que pertenece la línea, si el retailer divide la orden
   * (Paris: una orden "originOrderNumber" con sub-órdenes "ecl…-01" por despacho).
   * Las ventas y la liquidación de Paris usan la sub-orden.
   */
  subOrderNumber?: string | null;
  /** Cuándo recibió el cliente el producto (si el retailer lo informa) */
  deliveredAt?: Date | null;
  raw: unknown;
}

export interface NormalizedOrder {
  externalId: string;
  orderNumber: string | null;
  customerOrderId: string | null;
  orderDate: Date | null;
  status: string | null;
  customerName: string | null;
  customerRut: string | null;
  customerEmail: string | null;
  address: string | null;
  commune: string | null;
  region: string | null;
  /** Con IVA, productos + envío */
  total: number | null;
  shippingTotal: number | null;
  items: NormalizedItem[];
  raw: unknown;
}

export interface NormalizedProduct {
  sellerSku: string;
  retailerSku: string | null;
  name: string | null;
  brand: string | null;
  price: number | null;
  salePrice: number | null;
  stock: number | null;
  status: string | null;
  url: string | null;
  imageUrl: string | null;
  description?: string | null;
  raw: unknown;
}

/** Lo que se puede cambiar desde Cuadra en un producto del retailer */
export type EditableField = 'stock' | 'price' | 'salePrice' | 'name' | 'description';

/**
 * Cambios a enviar (solo los que vienen definidos).
 * Precios con IVA. salePrice = null quita la oferta. saleFrom / saleTo: AAAA-MM-DD.
 */
export interface ProductChanges {
  stock?: number;
  price?: number;
  salePrice?: number | null;
  saleFrom?: string;
  saleTo?: string;
  name?: string;
  description?: string;
}

/** Producto a modificar, tal como quedó guardado al traerlo */
export interface UpdateTarget {
  sellerSku: string;
  retailerSku: string | null;
  price: number | null;
  salePrice: number | null;
  raw: unknown;
}

export interface UpdateResult {
  /** APLICADO: el retailer ya lo tiene · EN_PROCESO: lo procesa después (consultar con checkUpdate) · RECHAZADO */
  status: 'APLICADO' | 'EN_PROCESO' | 'RECHAZADO';
  message: string;
  reference?: string | null;
}

export type Progress = (message: string) => void;

export interface RetailProvider {
  code: 'FALABELLA' | 'CENCOSUD' | 'WALMART';
  label: string;
  /** Dónde conseguir las credenciales (se muestra en Conexión) */
  howTo: string;
  docsUrl: string;
  fields: FieldDef[];
  /** Prueba la conexión: devuelve un mensaje y una muestra de la respuesta */
  test(cfg: ProviderConfig): Promise<{ message: string; sample?: unknown }>;
  /** Órdenes creadas entre dos fechas (AAAA-MM-DD, ambas incluidas) */
  orders(cfg: ProviderConfig, from: string, to: string, progress: Progress): Promise<NormalizedOrder[]>;
  products(cfg: ProviderConfig, progress: Progress): Promise<NormalizedProduct[]>;
  /** Campos que este retailer deja modificar por API */
  editable?: EditableField[];
  updateProduct?(cfg: ProviderConfig, target: UpdateTarget, changes: ProductChanges): Promise<UpdateResult>;
  /** Cómo terminó un cambio que quedó EN_PROCESO */
  checkUpdate?(cfg: ProviderConfig, reference: string): Promise<UpdateResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}
