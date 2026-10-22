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
  raw: unknown;
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
