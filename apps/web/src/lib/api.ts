import { healthResponseSchema, type HealthResponse, type OrderState } from '@cuadra/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4200/api';

export type ReceiptStatus = 'REGISTRADA' | 'EMITIENDO' | 'EMITIDA' | 'REVISAR' | 'BORRADOR';

/** ¿Está configurada la emisión de boletas en el SII (API Gateway)? */
export type SiiProvider = 'APIGATEWAY' | 'SIMPLEAPI' | 'NUBOX';

/** Lo que Cuadra puede hacer con el SII según el proveedor */
export interface SiiCapabilities {
  boletas: boolean;
  notasCredito: boolean;
  /** true: la nota queda emitida al tiro (Nubox) · false: borrador que se firma en el portal */
  notasCreditoDirectas: boolean;
  compras: boolean;
  comprasDetalle: boolean;
  cuadratura: boolean;
  facturasYGuias: boolean;
}

export interface SiiStatus {
  provider: SiiProvider;
  providerName: string;
  enabled: boolean;
  emisorRut: string | null;
  missing: string[];
  can: SiiCapabilities;
  supports: SiiCapabilities;
}

/** Lo que se va a emitir para una orden */
export interface BoletaPreview {
  retailerCode: string;
  orderNumber: string;
  wantsInvoice: boolean;
  item: string;
  total: number;
  productTotal: number;
  shippingTotal: number;
  receptorRut: string;
  receptorName: string;
  receptorAddress: string | null;
  receptorCommune: string | null;
  genericReceptor: boolean;
  existing: { id: string; number: string; status: string } | null;
  /** Fecha de la orden (AAAA-MM-DD) */
  orderDate: string | null;
  /** Fecha con que se emite la boleta (la de la orden) */
  issueDate: string;
}

export interface BoletaEmitida {
  ok: true;
  id: string;
  folio: number;
  total: number;
  orderNumber: string;
  /** Fecha de la boleta (AAAA-MM-DD) */
  issuedAt: string;
}

export interface BoletasLote {
  emitted: number;
  failed: number;
  results: (BoletaEmitida | { ok: false; orderNumber: string; error: string })[];
}

export interface ImportRetailer {
  code: string;
  name: string;
}

export interface ImportResult {
  retailer: string;
  fileName: string;
  totalRows: number;
  inserted: number;
  /** Filas omitidas porque su orden ya estaba en el sistema */
  skipped: number;
  skippedOrders: number;
  errors: { row: number; message: string }[];
}

/** Datos para emitir la boleta o factura de una orden en el SII */
export interface CustomerData {
  orderNumber: string;
  documentType: 'BOLETA' | 'FACTURA';
  customer: { name: string | null; rut: string | null; email: string | null };
  shipping: { name: string | null; address: string | null; commune: string | null; region: string | null };
  /** Solo si el cliente pidió factura */
  billing: { legalName: string | null; rut: string | null; activity: string | null; address: string | null } | null;
  lines: { productName: string | null; quantity: number; amountGross: number; amountNet: number }[];
  /** Con IVA */
  productTotal: number;
  shippingTotal: number;
  /** Producto + envío, con IVA */
  total: number;
  totalNet: number;
  totalVat: number;
}

/**
 * Una venta (orden) con su resultado:
 *   Total = Liquidación − Proveedor (con IVA) − IVA
 *   IVA   = IVA de la venta (boleta) − IVA de la compra − IVA de la comisión − IVA del envío
 */
export interface SaleRow {
  key: string;
  /** Código del retailer (para guardar la boleta) */
  retailerCode: string;
  retailer: string;
  orderNumber: string | null;
  /** N° de orden para mostrar (Walmart: el del cliente, no la PO "P…") */
  orderLabel: string | null;
  /** AAAA-MM-DD */
  orderDate: string | null;
  dispatchDeadline: string | null;
  productName: string | null;
  /** Estado de la orden tal como lo informa el retailer */
  status: string | null;
  cancelled: boolean;
  /** API: llegó sola por la conexión con el retailer · ARCHIVO: se subió el reporte */
  source: 'API' | 'ARCHIVO';
  customer: string | null;
  customerRut: string | null;
  /** FACTURA si el cliente la pidió; si no, BOLETA */
  documentRequested: 'BOLETA' | 'FACTURA';
  /** Costo sin IVA: de la factura del proveedor o estimado con el costo del producto */
  cost: number | null;
  costSource: 'FACTURA' | 'ESTIMADO' | null;
  /** Costo con IVA (lo que se le paga al proveedor) */
  costGross: number | null;
  /** Estado global de la orden y el que informa el retailer */
  state: OrderState;
  statusRaw: string | null;
  /** Envío que pagó el cliente y venta + envío (con IVA) */
  shippingPrice: number;
  saleTotal: number | null;
  /** Lo que se queda el retailer (comisión, envío, otros); estimada con el contrato si aún no paga */
  settlementCharges: number | null;
  settlementEstimated: boolean;
  /** IVA de la venta − IVA del costo − IVA de la liquidación */
  vatToPay: number | null;
  /** Venta − costo − IVA − liquidación */
  utility: number | null;
  utilityEstimated: boolean;
  /** Lo que pagó el cliente por el producto (con IVA) */
  salePrice: number | null;
  /** Boleta al cliente final (producto + envío, con IVA) */
  receipt: {
    id: string;
    number: string;
    totalGross: number;
    /** REGISTRADA (a mano) · EMITIENDO · EMITIDA (en el SII desde el sistema) · REVISAR */
    status: ReceiptStatus;
    /** Fecha de emisión en el SII (AAAA-MM-DD); null si se anotó a mano */
    issuedAt: string | null;
    /** Total de notas de crédito emitidas/anotadas (con IVA) */
    creditNotes: number;
    /** Notas en borrador (falta firmarlas en MIPYME) */
    draftCreditNotes: number;
    /** 39 boleta · 33 factura */
    documentType: number;
  } | null;
  /** Neto pagado por el retailer en la liquidación. null = aún no paga */
  settlementNet: number | null;
  /** Comisión cobrada (negativa, con IVA) */
  commission: number | null;
  /** Cargos de envío y logística (negativos, con IVA) */
  shippingCharges: number | null;
  /** Factura del proveedor con IVA / sin IVA. null = sin factura */
  supplierGross: number | null;
  supplierNet: number | null;
  vatSale: number | null;
  vatPurchase: number;
  vatCommission: number;
  vatShipping: number;
  /** IVA a pagar */
  vat: number | null;
  /** null hasta tener liquidación y factura */
  total: number | null;
  /** Total / precio de venta (%) */
  marginPct: number | null;
}

export interface SettlementImportResult {
  retailer: string;
  fileName: string;
  totalRows: number;
  /** Movimientos nuevos */
  inserted: number;
  /** Movimientos que ya existían (se actualizó su estado de pago) */
  updated: number;
  errors: { row: number; message: string }[];
}

export type ReconciliationStatus =
  | 'CONCILIADA'
  | 'CON_DIFERENCIA'
  | 'PENDIENTE'
  | 'SIN_VENTA'
  | 'CANCELADA'
  | 'MULTA';

export interface ReconciliationRow {
  status: ReconciliationStatus;
  reasons: string[];
  orderNumber: string | null;
  /** N° de orden para mostrar (Walmart: el del cliente, no la PO "P…") */
  orderLabel: string | null;
  itemId: string | null;
  orderDate: string | null;
  productName: string | null;
  sellerSku: string | null;
  salePrice: number | null;
  productPaid: number | null;
  commission: number | null;
  commissionPct: number | null;
  otherCharges: number | null;
  net: number | null;
  paymentStatus: string | null;
  statementNumber: string | null;
  /** "A recibir" de Productos (sin IVA), según el costo del producto master. null = sin costo */
  expectedNet: number | null;
  /** Debíamos recibir = "A recibir" de Productos, sin IVA */
  expected: number | null;
  /** Total = Neto − Debíamos recibir (positivo = ganancia, negativo = pérdida) */
  result: number | null;
  /** Productos de la venta sin costo. masterId/masterSku = tiene master, pero sin costo */
  missingProducts: MissingCostProduct[];
  /** Documentos de compra (facturas del proveedor) agregados a esta orden */
  documents: RowDocument[];
}

/** Documento de compra ligado a una orden de la conciliación */
export interface RowDocument {
  lineId: string;
  documentId: string;
  documentNumber: string;
  supplier: string;
  /** Sin IVA */
  amountNet: number;
  /** Con IVA */
  amountGross: number;
}

/** Factura del proveedor con sus totales y lo pagado */
export interface PurchaseInvoice {
  id: string;
  supplierId: string;
  supplier: string;
  documentNumber: string;
  /** Clientes (retailers) de las órdenes de la factura. Ej: ["Falabella"] */
  clients: string[];
  /** Fecha en que se ingresó (AAAA-MM-DD) */
  createdAt: string;
  /** Fecha de la factura (AAAA-MM-DD): mes de su IVA crédito */
  issueDate: string;
  orders: number;
  net: number;
  vat: number;
  /** Total con IVA */
  total: number;
  paid: number;
  /** Lo que falta pagar */
  balance: number;
  status: 'PENDIENTE' | 'PARCIAL' | 'PAGADA' | 'NOTA_CREDITO';
  /** Tipo SII: 33 factura, 34 exenta, 61 nota de crédito… */
  documentType: number;
  supplierRut: string | null;
  /** Traída del Registro de Compras del SII (montos del SII) */
  fromSii: boolean;
  siiStatus: string | null;
  /** Neto ya asignado a órdenes */
  assignedNet: number;
  lastPaymentAt: string | null;
}

/** Documento del Registro de Compras del SII comparado con el ERP */
export interface SiiPurchase {
  key: string;
  type: number;
  typeLabel: string;
  supplierRut: string;
  supplierName: string;
  folio: string;
  issueDate: string | null;
  receivedAt: string | null;
  exempt: number;
  net: number;
  vat: number;
  total: number;
  siiStatus: 'REGISTRO' | 'PENDIENTE';
  /** NUEVA: no está · COINCIDE: se ingresó a mano · IMPORTADA: ya se trajo */
  erpStatus: 'NUEVA' | 'COINCIDE' | 'IMPORTADA';
  documentId: string | null;
  erpSupplier: string | null;
  /** La emitió un retailer (comisiones): se guarda solo para cuadrar con las liquidaciones */
  retailer: { id: string; name: string } | null;
  assignedNet: number;
}

export interface SiiPurchasesPreview {
  month: string;
  warnings: string[];
  documents: SiiPurchase[];
  totals: { count: number; net: number; vat: number; total: number; newCount: number; retailerCount: number };
}

export interface PurchaseInvoiceDetail extends PurchaseInvoice {
  lines: { id: string; retailer: string; orderNumber: string | null; productName: string | null; net: number; total: number }[];
  payments: {
    id: string;
    amount: number;
    paidAt: string;
    method: string | null;
    note: string | null;
    createdBy: string | null;
  }[];
}
export interface Supplier {
  id: string;
  name: string;
}

export interface NewPurchaseDocument {
  supplier: string;
  documentNumber: string;
  /** Fecha de la factura (AAAA-MM-DD) */
  issueDate?: string | null;
  /** Opción de conciliación elegida (ej: CENCOSUD, CENCOSUD_FULFILLMENT) */
  retailerCode: string;
  lines: { itemKey: string; orderNumber: string | null; productName: string | null; amountNet: string }[];
}

export interface MissingCostProduct {
  sellerSku: string | null;
  name: string | null;
  masterId: string | null;
  masterSku: string | null;
}

export interface ReconciliationResult {
  retailer: string;
  /** Código del retailer en la base (ej: CENCOSUD, también para la opción fulfillment) */
  retailerCode: string;
  contractCommissionPct: number | null;
  summary: Record<ReconciliationStatus, number>;
    totals: {
    salePrice: number;
    productPaid: number;
    commission: number;
    otherCharges: number;
    net: number;
    /** Neto, Debíamos recibir y Total de las filas que tienen total */
    resultNet: number;
    expected: number;
    result: number;
  };
  /** Ventas pagadas cuyo producto no tiene master/costo */
  rowsWithoutCost: number;
  /** Pagos de productos sin venta cargada */
  rowsWithoutSale: number;
  rows: ReconciliationRow[];
}

/** Comisión, logística y precio sugerido de un producto en un retailer */
export interface ProductChannel {
  commissionPct: string | null;
  logisticsCost: string | null;
  /** Precio a publicar, redondeado a ...990 (null si falta la comisión) */
  suggestedPrice: number | null;
  /** Neto que queda al publicar a ese precio */
  netAtPrice: number | null;
}

/** Producto MASTER (genérico, ej: "Seccional Richter") */
export interface Product {
  id: string;
  skuMaster: string;
  name: string;
  /** Costo momentáneo neto, como texto exacto: "185000.00" */
  provisionalCost: string;
  /** % utilidad y % devoluciones sobre el costo: "20.00" */
  profitPct: string;
  returnsPct: string;
  /** Neto que debemos recibir por unidad */
  targetNet: number;
  /** Por código de retailer: CENCOSUD, WALMART, FALABELLA, HITES */
  channels: Record<string, ProductChannel>;
}

/** Insumo (tela, espuma, patas...) */
export interface Supply {
  id: string;
  sku: string;
  name: string;
  /** Costo neto por unidad, como texto exacto: "4500.00" */
  netCost: string;
}

export interface ProductInput {
  skuMaster: string;
  name: string;
  provisionalCost: string;
  profitPct?: string;
  returnsPct?: string;
  channels?: Record<string, { commissionPct: string | null; logisticsCost: string | null }>;
}
export type SupplyInput = { sku: string; name: string; netCost: string };

/** Retailer con catálogo cargable, con conteos */
export interface CatalogRetailer {
  code: string;
  name: string;
  total: number;
  /** Productos sin master asignado */
  unassigned: number;
}

/** Producto del catálogo de un retailer, con su master (si tiene) */
export interface CatalogRow {
  id: string;
  retailerSku: string;
  sellerSku: string | null;
  name: string;
  listPrice: string | null;
  offerPrice: string | null;
  offerFrom: string | null;
  offerTo: string | null;
  status: string | null;
  stock: number | null;
  imageUrl: string | null;
  productId: string | null;
  productSku: string | null;
  productName: string | null;
}

export interface CatalogImportResult {
  retailer: string;
  fileName: string;
  totalRows: number;
  inserted: number;
  updated: number;
  errors: { row: number; message: string }[];
  /** Productos del sistema que no vienen en el archivo */
  missing: CatalogRow[];
}

/** Un producto en el ranking de más vendidos */
/** Un producto (de un retailer) en el ranking de más vendidos */
export interface TopProduct {
  key: string;
  retailerCode: string;
  /** Nombre a mostrar: Paris, Walmart, Falabella, Hites */
  retailerLabel: string;
  /** SKU del producto en el retailer (ej: Paris MK8400CF1K) */
  retailerSku: string | null;
  /** SKU del vendedor (ej: SECRICHFBNGCL) */
  sellerSku: string | null;
  name: string;
  /** false = la venta no se encontró en el catálogo del retailer */
  inCatalog: boolean;
  units: number;
  /** Venta bruta con IVA */
  revenue: number;
  orders: number;
}

export interface TopProductsReport {
  from: string | null;
  to: string | null;
  totals: { units: number; revenue: number; orders: number };
  /** Top 5 de todos los retailers juntos */
  overall: TopProduct[];
  retailers: { code: string; label: string; units: number; revenue: number; products: TopProduct[] }[];
}

/** Ventas de un período: todo con IVA, sin contar las canceladas */
export interface SalesKpis {
  revenue: number;
  units: number;
  orders: number;
  avgTicket: number;
  cancelledOrders: number;
}

/** Resultado de la conciliación de un retailer (acumulado) */
export interface DashboardConciliation {
  code: string;
  label: string;
  net: number;
  resultNet: number;
  expected: number;
  /** Total = Neto − Debíamos recibir (positivo = ganancia) */
  result: number;
  conciliated: number;
  withDifference: number;
  pendingCount: number;
  pendingAmount: number;
  penalties: number;
  rowsWithoutCost: number;
  rowsWithoutSale: number;
}

export interface Dashboard {
  from: string | null;
  to: string | null;
  previous: { from: string; to: string } | null;
  kpis: SalesKpis;
  previousKpis: SalesKpis | null;
  trend: { granularity: 'day' | 'month'; points: { date: string; revenue: number; units: number }[] };
  byRetailer: { code: string; label: string; revenue: number; units: number; orders: number; share: number }[];
  topProducts: TopProduct[];
  conciliation: { retailers: DashboardConciliation[]; totals: Omit<DashboardConciliation, 'code' | 'label'> };
  dispatch: {
    pending: number;
    overdue: number;
    dueToday: number;
    next: {
      retailerLabel: string;
      orderNumber: string | null;
      productName: string | null;
      status: string | null;
      deadline: string | null;
      daysLeft: number | null;
    }[];
  };
  alerts: { catalogWithoutMaster: number; mastersWithoutCost: number; salesWithoutCatalog: number };
}

export type UserRole = 'DUENO' | 'ADMIN' | 'OPERADOR' | 'LECTURA';

export interface MyTenant {
  id: string;
  name: string;
  role: UserRole;
  plan: string;
  status: string;
}

/** Usuario con sesión iniciada y su empresa actual */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  mustChangePassword: boolean;
  tenantId: string | null;
  tenantName: string | null;
  role: UserRole;
  tenants: MyTenant[];
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface Company {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  plan: string;
  status: string;
  trialEndsAt: string | null;
  onboarding: Record<string, string>;
}

export interface SiiConfig {
  provider: SiiProvider;
  providerName: string;
  simpleapiKey: string | null;
  nuboxUrl: string;
  nuboxToken: string | null;
  nuboxApiKey: string | null;
  missing: string[];
  emisorRut: string | null;
  usuarioRut: string | null;
  sucursal: string | null;
  apigatewayUrl: string;
  token: string | null;
  clave: string | null;
  configured: boolean;
}

export interface HomeTask {
  id: string;
  title: string;
  why: string;
  action: string;
  href: string;
  count: number;
  tone: 'rojo' | 'amarillo' | 'azul';
}

export interface HomeSummary {
  month: string;
  from: string;
  to: string;
  company: string;
  sold: number;
  orders: number;
  cancelled: number;
  paid: number;
  owed: number;
  owedOverdue: number;
  supplierCost: number;
  vatToPay: number | null;
  profit: number;
  profitOrders: number;
  profitPct: number | null;
  byRetailer: { retailer: string; sold: number; orders: number; paid: number }[];
  tasks: HomeTask[];
  setup: { siiConfigured: boolean; hasProducts: boolean; hasSales: boolean; hasSettlements: boolean; retailersConnected: number };
}

export interface Onboarding {
  steps: { id: 'empresa' | 'ventas' | 'liquidaciones' | 'costos' | 'sii'; status: 'HECHO' | 'SALTADO' | 'PENDIENTE' }[];
  completed: number;
  total: number;
}

export interface AdminTenant {
  id: string;
  name: string;
  taxId: string | null;
  plan: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
  users: number;
  orders: number;
  lastOrder: string | null;
  receipts: number;
  owner: string | null;
}

// ===================== Maestra de retailers =====================

export type PaymentBase = 'ORDEN' | 'DESPACHO';
export type ChannelType = 'department_store' | 'supermarket' | 'marketplace' | 'ecommerce' | 'other';

export interface RetailerMaster {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  channelType: ChannelType;
  commissionPct: number;
  paymentDays: number;
  paymentBase: PaymentBase;
  contact: string | null;
  commercialTerms: string | null;
  isActive: boolean;
  orders: number;
  lastOrderDate: string | null;
}

// ===================== Notas de crédito =====================

export type CreditNoteStatus = 'BORRADOR' | 'EMITIDA' | 'REGISTRADA' | 'ERROR';

export interface CreditNote {
  id: string;
  retailerCode: string;
  retailer: string;
  orderNumber: string;
  receiptNumber: string;
  receiptDate: string | null;
  refCode: 1 | 3;
  reason: string;
  amountGross: number;
  status: CreditNoteStatus;
  draftCode: string | null;
  folio: string | null;
  issuedAt: string | null;
  error: string | null;
  notes: string | null;
  createdAt: string;
  returnId: string | null;
  /** Emitida en el Portal MIPYME: se puede ver su PDF */
  hasPdf: boolean;
  /** 39 boleta · 33 factura */
  receiptType: number;
}

/** Orden cancelada con boleta a la que le falta nota de crédito */
export interface CreditNotePending {
  retailerCode: string;
  retailer: string;
  orderNumber: string;
  orderId: string | null;
  orderDate: string | null;
  productName: string | null;
  status: string | null;
  receiptNumber: string;
  receiptTotal: number;
  receiptDate: string | null;
  credited: number;
  missing: number;
}

export interface CreditNotePreview {
  retailerCode: string;
  orderNumber: string;
  receiptNumber: string;
  receiptType: number;
  receiptDate: string | null;
  receiptTotal: number;
  credited: number;
  available: number;
  customerName: string;
  customerRut: string;
  address: string | null;
  commune: string | null;
  item: string;
}

export interface CreditNoteInput {
  retailerCode: string;
  orderNumber: string;
  amountGross: number | string;
  refCode: 1 | 3;
  reason: string;
  returnId?: string | null;
}

// ===================== Devoluciones =====================

export type ReturnStatus = 'SOLICITADA' | 'EN_TRANSITO' | 'RECIBIDA' | 'CERRADA' | 'RECHAZADA';
export type SupplierAction = 'NINGUNA' | 'DEVUELTO' | 'NC_PROVEEDOR';

export interface ProductReturn {
  id: string;
  retailerCode: string;
  retailer: string;
  orderNumber: string;
  orderId: string | null;
  orderDate: string | null;
  productName: string | null;
  salePrice: number | null;
  requestedAt: string;
  scope: 'TOTAL' | 'PARCIAL';
  reason: string;
  status: ReturnStatus;
  receivedAt: string | null;
  productCondition: 'BUENO' | 'DANADO' | null;
  refundGross: number | null;
  reverseLogisticsCost: number | null;
  supplierAction: SupplierAction;
  supplierCreditGross: number | null;
  trackingCode: string | null;
  notes: string | null;
  receipt: { number: string; totalGross: number } | null;
  creditNote: { id: string; status: CreditNoteStatus; folio: string | null; amountGross: number } | null;
  /** Cargos de logística que trae la liquidación de esa orden */
  settlementLogistics: number | null;
  /** Lo que le cuesta la devolución a la empresa */
  netCost: number;
}

export interface ReturnInput {
  retailerCode: string;
  orderNumber: string;
  requestedAt: string;
  scope: 'TOTAL' | 'PARCIAL';
  reason: string;
  status: ReturnStatus;
  receivedAt: string | null;
  productCondition: 'BUENO' | 'DANADO' | null;
  refundGross: string | null;
  reverseLogisticsCost: string | null;
  supplierAction: SupplierAction;
  supplierCreditGross: string | null;
  trackingCode: string | null;
  notes: string | null;
}

// ===================== Cuentas por cobrar =====================

export type AgingBucket = 'POR_VENCER' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90';

export interface Receivables {
  today: string;
  buckets: { key: AgingBucket; label: string }[];
  totals: { orders: number; expected: number; overdue: number; buckets: Record<AgingBucket, number> };
  retailers: {
    code: string;
    name: string;
    orders: number;
    expected: number;
    overdue: number;
    buckets: Record<AgingBucket, number>;
    paymentDays: number;
    paymentBase: PaymentBase;
    commissionPct: number;
  }[];
  items: {
    retailerCode: string;
    retailer: string;
    orderNumber: string;
    orderLabel: string | null;
    orderDate: string | null;
    productName: string | null;
    status: string | null;
    salePrice: number;
    commissionPct: number;
    expected: number;
    baseDate: string | null;
    dueDate: string | null;
    daysOverdue: number;
    daysToDue: number;
    bucket: AgingBucket;
  }[];
  missingCommission: string[];
}

// ===================== IVA =====================

export interface VatMonth {
  month: string;
  debitReceipts: number;
  debitCreditNotes: number;
  debit: number;
  creditPurchases: number;
  creditCommissions: number;
  creditLogistics: number;
  credit: number;
  balance: number;
  salesWithoutReceipt: number;
  salesWithoutReceiptVat: number;
  draftCreditNotes: number;
  /** IVA de las facturas de retailers traídas del SII (null si no hay) */
  retailerInvoicesVat: number | null;
}

export interface VatDocument {
  date: string | null;
  kind: 'BOLETA' | 'NOTA_CREDITO' | 'COMPRA' | 'COMISION' | 'LOGISTICA' | 'FACTURA_RETAILER';
  retailer: string | null;
  reference: string;
  description: string | null;
  gross: number;
  vat: number;
}

/** Lanza un Error con el mensaje que devuelve la API (ej: "Faltan las columnas: ...") */
async function handle<T>(res: Response): Promise<T> {
    // Sesión vencida o sin iniciar: se manda al login (salvo que ya estemos ahí)
  if (res.status === 401 && typeof window !== 'undefined' && !['/login', '/registro'].includes(window.location.pathname)) {
    window.location.href = '/login';
  }
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* respuesta sin JSON */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- Portal MIPYME

export interface MipymeSyncResult {
  checked: number;
  emitted: { label: string; folio: string }[];
  stillDraft: number;
  notFound: string[];
}

export interface FacturaReceptor {
  rut: string;
  name: string;
  activity: string;
  address: string;
  commune: string;
}

export interface FacturaPreview {
  retailerCode: string;
  orderNumber: string;
  item: string;
  total: number;
  issueDate: string;
  existing: { id: string; number: string; status: string } | null;
  wantsInvoice: boolean;
  receptor: FacturaReceptor;
}

export interface Contribuyente {
  rut: string;
  razonSocial: string | null;
  direcciones: { direccion: string; comuna: string }[];
  actividades: { codigo: string; glosa: string }[];
}

export interface SalesCheck {
  month: string;
  types: {
    type: number;
    name: string;
    erp: { count: number; total: number };
    sii: { count: number; total: number } | null;
    countDiff: number | null;
    totalDiff: number | null;
  }[];
}

export interface InvoiceItem {
  line: number;
  code: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  price: number;
  discount: number;
  amount: number;
}

export interface OrderSuggestion {
  retailerCode: string;
  retailer: string;
  itemKey: string;
  orderNumber: string;
  orderLabel: string;
  orderDate: string | null;
  productName: string | null;
  sellerSku: string | null;
  expectedNet: number | null;
  score: number;
}

export interface DispatchGuide {
  id: string;
  guideDate: string;
  transferType: number;
  transferLabel: string;
  receptorRut: string;
  receptorName: string;
  receptorActivity: string | null;
  address: string | null;
  commune: string | null;
  items: { name: string; quantity: number; price: number }[];
  totalGross: number;
  reference: string | null;
  status: 'BORRADOR' | 'EMITIDA';
  draftCode: string | null;
  folio: string | null;
  issuedAt: string | null;
  hasPdf: boolean;
  notes: string | null;
}

export type GuideInput = Omit<DispatchGuide, 'id' | 'transferLabel' | 'totalGross' | 'status' | 'draftCode' | 'folio' | 'issuedAt' | 'hasPdf'>;

// ---------------------------------------------------------------- API Retail

export type RetailProviderCode = 'FALABELLA' | 'CENCOSUD' | 'WALMART';

export interface RetailApiConnection {
  provider: RetailProviderCode;
  label: string;
  howTo: string;
  docsUrl: string;
  fields: { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; default?: string }[];
  enabled: boolean;
  configured: boolean;
  settings: Record<string, string>;
  /** Solo los últimos 4 caracteres ("••••abcd") o null si no está guardada */
  secrets: Record<string, string | null>;
  status: 'SIN_PROBAR' | 'OK' | 'ERROR';
  lastError: string | null;
  lastTestAt: string | null;
  lastOrdersSyncAt: string | null;
  lastProductsSyncAt: string | null;
}

export interface RetailSyncJob {
  id: string;
  provider: RetailProviderCode;
  kind: 'orders' | 'products';
  status: 'RUNNING' | 'DONE' | 'ERROR';
  message: string;
  count: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface RetailApiOrder {
  id: string;
  provider: RetailProviderCode;
  retailer: string;
  externalId: string;
  orderNumber: string | null;
  customerOrderId: string | null;
  /** "AAAA-MM-DD HH:MM" hora de Chile */
  orderDate: string | null;
  status: string | null;
  customerName: string | null;
  customerRut: string | null;
  customerEmail: string | null;
  address: string | null;
  commune: string | null;
  region: string | null;
  total: number | null;
  shippingTotal: number | null;
  items: { sellerSku: string | null; name: string | null; quantity: number; paidPrice: number | null; status: string | null }[];
  /** La orden también está en Ventas (cargada por archivo) */
  inErp: boolean;
  syncedAt: string;
  cancelled: boolean;
  /** Boleta o factura de la orden (por N° de orden) */
  receipt: { id: string; number: string; status: ReceiptStatus; documentType: number; totalGross: number; creditNotes: number } | null;
  /** Liquidación del retailer: neto pagado, comisión (negativa) y cargos de envío/logística */
  settlement: { net: number; commission: number; charges: number; paymentStatus: string | null; statement: string | null } | null;
  /** Factura del proveedor asignada a la orden */
  supplier: { net: number; gross: number; documents: string[] } | null;
  /** IVA a pagar de la orden: venta − compra − cargos del retailer */
  vat: number;
  /** Liquidación − proveedor − IVA (null si falta liquidación o factura) */
  result: number | null;
  marginPct: number | null;
}

export interface RetailApiProduct {
  id: string;
  provider: RetailProviderCode;
  retailer: string;
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
  syncedAt: string;
  inCatalog: boolean;
  masterSku: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include', // envía la cookie de sesión
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return handle<T>(res);
}

export const api = {
    /** Sesión */
  // Cuenta y empresas
  login: (email: string, password: string) => request<{ ok: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signup: (data: { name: string; email: string; password: string; companyName: string; taxId?: string }) =>
    request<{ ok: boolean }>('/auth/signup', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => request<SessionUser>('/auth/me'),
  switchTenant: (tenantId: string) => request<{ ok: boolean }>('/auth/switch', { method: 'POST', body: JSON.stringify({ tenantId }) }),
  createTenant: (companyName: string, taxId?: string) =>
    request<{ id: string }>('/auth/tenants', { method: 'POST', body: JSON.stringify({ companyName, taxId }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  team: () => request<TeamMember[]>('/team'),
  invite: (data: { email: string; name: string; role: UserRole }) =>
    request<{ ok: boolean; email: string; tempPassword: string | null }>('/team', { method: 'POST', body: JSON.stringify(data) }),
  updateMember: (id: string, data: { role?: UserRole; isActive?: boolean }) =>
    request<{ ok: boolean }>(`/team/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeMember: (id: string) => request<{ deleted: boolean }>(`/team/${id}`, { method: 'DELETE' }),

  // Empresa, inicio y asistente
  home: (month?: string) => request<HomeSummary>(`/home${month ? `?month=${month}` : ''}`),
  company: () => request<Company>('/company'),
  saveCompany: (data: { name?: string; legalName?: string | null; taxId?: string | null }) =>
    request<Company>('/company', { method: 'PATCH', body: JSON.stringify(data) }),
  siiConfig: () => request<SiiConfig>('/company/sii'),
  saveSiiConfig: (data: {
    provider?: SiiProvider;
    usuarioRut?: string;
    sucursal?: string;
    apigatewayUrl?: string;
    token?: string;
    clave?: string;
    simpleapiKey?: string;
    nuboxUrl?: string;
    nuboxToken?: string;
    nuboxApiKey?: string;
  }) =>
    request<SiiConfig>('/company/sii', { method: 'PUT', body: JSON.stringify(data) }),
  testSii: () => request<{ ok: boolean; message: string }>('/company/sii/test', { method: 'POST' }),
  onboarding: () => request<Onboarding>('/company/onboarding'),
  markOnboarding: (step: string, value: 'SALTADO' | 'HECHO' | null) =>
    request<Onboarding>(`/company/onboarding/${step}`, { method: 'POST', body: JSON.stringify({ value }) }),

  // Superadmin
  adminTenants: () => request<AdminTenant[]>('/admin/tenants'),
  adminUpdateTenant: (id: string, data: { plan?: string; status?: string; trialEndsAt?: string | null }) =>
    request<{ ok: boolean }>(`/admin/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminEnter: (id: string) => request<{ ok: boolean }>(`/admin/tenants/${id}/enter`, { method: 'POST' }),

  /** Valida la respuesta con el mismo schema Zod que usa el backend */
  health: async (): Promise<HealthResponse> =>
    healthResponseSchema.parse(await request<unknown>('/health')),

  /** Ventas cargadas (las más recientes primero) */
  /** Ventas por fecha de la orden (AAAA-MM-DD). Sin fechas: desde el 20 del mes pasado hasta hoy */
  listSales: (from?: string, to?: string) =>
    request<SaleRow[]>(`/sales${from && to ? `?from=${from}&to=${to}` : ''}`),

    /** Datos del cliente de una orden (para la boleta o factura del SII) */
  customerData: (retailerCode: string, orderNumber: string) =>
    request<CustomerData>(
      `/sales/customer?retailer=${encodeURIComponent(retailerCode)}&order=${encodeURIComponent(orderNumber)}`,
    ),

  /** Boleta al cliente final de una orden (si ya tiene, se reemplaza) */
  saveReceipt: (data: { retailerCode: string; orderNumber: string; receiptNumber: string; totalGross: string }) =>
    request<{ id: string }>('/sales/receipts', { method: 'POST', body: JSON.stringify(data) }),
  deleteReceipt: (id: string) => request<{ deleted: boolean }>(`/sales/receipts/${id}`, { method: 'DELETE' }),

  /** Maestra de retailers */
  listRetailers: () => request<RetailerMaster[]>('/retailers'),
  updateRetailer: (id: string, data: Partial<Omit<RetailerMaster, 'id' | 'code' | 'orders' | 'lastOrderDate' | 'commissionPct'>> & { commissionPct?: string | number }) =>
    request<{ ok: boolean }>(`/retailers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  /** Notas de crédito */
  listCreditNotes: () => request<CreditNote[]>('/credit-notes'),
  pendingCreditNotes: () => request<CreditNotePending[]>('/credit-notes/pending'),
  creditNotePreview: (retailerCode: string, orderNumber: string) =>
    request<CreditNotePreview>(
      `/credit-notes/preview?retailer=${encodeURIComponent(retailerCode)}&order=${encodeURIComponent(orderNumber)}`,
    ),
  draftCreditNote: (data: CreditNoteInput) =>
    request<{ id: string; draftCode: string | null; folio: string | null }>('/credit-notes/draft', { method: 'POST', body: JSON.stringify(data) }),
  registerCreditNote: (data: CreditNoteInput & { folio: string; issuedAt: string }) =>
    request<{ id: string }>('/credit-notes/register', { method: 'POST', body: JSON.stringify(data) }),
  confirmCreditNote: (id: string, data: { folio: string; issuedAt: string }) =>
    request<{ ok: boolean }>(`/credit-notes/${id}/confirm`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCreditNote: (id: string) => request<{ deleted: boolean }>(`/credit-notes/${id}`, { method: 'DELETE' }),

  /** Devoluciones */
  listReturns: () => request<ProductReturn[]>('/returns'),
  createReturn: (data: ReturnInput) => request<{ id: string }>('/returns', { method: 'POST', body: JSON.stringify(data) }),
  updateReturn: (id: string, data: Partial<ReturnInput>) =>
    request<{ id: string }>(`/returns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteReturn: (id: string) => request<{ deleted: boolean }>(`/returns/${id}`, { method: 'DELETE' }),

  /** Cuentas por cobrar */
  receivables: () => request<Receivables>('/receivables'),

  /** Resumen de IVA */
  vatMonths: (months = 12) => request<VatMonth[]>(`/vat?months=${months}`),
  vatDetail: (month: string) => request<VatDocument[]>(`/vat/${month}`),
  vatCsvUrl: (month: string) => `${API_URL}/vat/${month}/csv`,

  // API Retail
  retailConnections: () => request<RetailApiConnection[]>('/retail-api/connections'),
  saveRetailConnection: (provider: RetailProviderCode, data: { enabled: boolean; settings: Record<string, string>; secrets: Record<string, string> }) =>
    request<{ ok: boolean }>(`/retail-api/connections/${provider}`, { method: 'PUT', body: JSON.stringify(data) }),
  testRetailConnection: (provider: RetailProviderCode) =>
    request<{ ok: boolean; message: string; sample: string | null; job?: RetailSyncJob }>(`/retail-api/connections/${provider}/test`, { method: 'POST' }),
  syncRetailOrders: (provider: RetailProviderCode, from: string, to: string) =>
    request<RetailSyncJob>(`/retail-api/${provider}/orders/sync`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  syncRetailProducts: (provider: RetailProviderCode) => request<RetailSyncJob>(`/retail-api/${provider}/products/sync`, { method: 'POST' }),
  retailJob: (id: string) => request<RetailSyncJob>(`/retail-api/jobs/${id}`),
  retailOrders: (from: string, to: string, provider?: string) =>
    request<RetailApiOrder[]>(`/retail-api/orders?from=${from}&to=${to}${provider ? `&provider=${provider}` : ''}`),
  retailOrderRaw: (id: string) => request<unknown>(`/retail-api/orders/${id}/raw`),
  retailProducts: (provider?: string) => request<RetailApiProduct[]>(`/retail-api/products${provider ? `?provider=${provider}` : ''}`),

  // Portal MIPYME
  mipymeSync: () => request<MipymeSyncResult>('/sii/mipyme/sincronizar', { method: 'POST' }),
  contribuyente: (rut: string) => request<Contribuyente>(`/sii/mipyme/contribuyente/${encodeURIComponent(rut)}`),
  facturaPreview: (retailerCode: string, orderNumber: string) =>
    request<FacturaPreview>(
      `/sii/mipyme/facturas/preview?retailer=${encodeURIComponent(retailerCode)}&order=${encodeURIComponent(orderNumber)}`,
    ),
  createFactura: (data: { retailerCode: string; orderNumber: string; receptor: FacturaReceptor }) =>
    request<{ id: string; draftCode: string }>('/sii/mipyme/facturas', { method: 'POST', body: JSON.stringify(data) }),
  deleteFactura: (id: string) => request<{ deleted: boolean; portal: string }>(`/sii/mipyme/facturas/${id}`, { method: 'DELETE' }),
  salesCheck: (month: string) => request<SalesCheck>(`/sii/mipyme/ventas/${month}`),
  creditNotePdfUrl: (id: string) => `${API_URL}/sii/mipyme/notas-credito/${id}/pdf`,
  purchasePdfUrl: (id: string) => `${API_URL}/sii/mipyme/compras/${id}/pdf`,
  purchaseItems: (id: string, refresh = false) =>
    request<{ items: (InvoiceItem & { suggestions: OrderSuggestion[] })[] }>(
      `/sii/mipyme/compras/${id}/productos${refresh ? '?refresh=1' : ''}`,
    ),
  listGuides: () => request<DispatchGuide[]>('/sii/mipyme/guias'),
  createGuide: (data: GuideInput) =>
    request<{ id: string; draftCode: string }>('/sii/mipyme/guias', { method: 'POST', body: JSON.stringify(data) }),
  confirmGuide: (id: string, folio: string, issuedAt: string) =>
    request<{ ok: boolean }>(`/sii/mipyme/guias/${id}/folio`, { method: 'PATCH', body: JSON.stringify({ folio, issuedAt }) }),
  deleteGuide: (id: string) => request<{ deleted: boolean; portal: string | null }>(`/sii/mipyme/guias/${id}`, { method: 'DELETE' }),
  guidePdfUrl: (id: string) => `${API_URL}/sii/mipyme/guias/${id}/pdf`,

  /** Boletas en el SII (API Gateway) */
  siiStatus: () => request<SiiStatus>('/sii/status'),
  boletaPreview: (retailerCode: string, orderNumber: string) =>
    request<BoletaPreview>(
      `/sii/boletas/preview?retailer=${encodeURIComponent(retailerCode)}&order=${encodeURIComponent(orderNumber)}`,
    ),
  emitBoleta: (retailerCode: string, orderNumber: string) =>
    request<BoletaEmitida>('/sii/boletas', { method: 'POST', body: JSON.stringify({ retailerCode, orderNumber }) }),
  emitBoletas: (orders: { retailerCode: string; orderNumber: string }[]) =>
    request<BoletasLote>('/sii/boletas/lote', { method: 'POST', body: JSON.stringify({ orders }) }),
  /** PDF de una boleta emitida (se abre en otra pestaña con la cookie de sesión) */
  /** Nombre del PDF (sin .pdf): Falabella "<N° orden>_<N° boleta>", resto "<N° orden>" */
  boletaFileName: (sale: SaleRow, receiptNumber?: string | number | null) => {
    const order = (sale.orderLabel ?? sale.orderNumber ?? 'orden').replace(/[^\w.-]+/g, '_');
    const number = receiptNumber ?? sale.receipt?.number;
    return sale.retailerCode.toUpperCase() === 'FALABELLA' && number ? `${order}_${number}` : order;
  },
  boletaPdfUrl: (receiptId: string, orderLabel?: string | null) =>
    `${API_URL}/sii/boletas/${receiptId}/pdf${orderLabel ? `/${encodeURIComponent(orderLabel.replace(/[^\w.-]+/g, '_'))}.pdf` : ''}`,

  /** Retailers cuyos archivos de ventas se pueden cargar */
  importRetailers: () => request<ImportRetailer[]>('/sales/import/retailers'),

  /** Sube un Excel de ventas. No se fija Content-Type: el navegador lo arma con FormData */
  importSales: async (retailerCode: string, file: File): Promise<ImportResult> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_URL}/sales/import/${retailerCode}`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    return handle<ImportResult>(res);
  },

    /** Retailers cuyos archivos de liquidación se pueden cargar */
  settlementRetailers: () => request<ImportRetailer[]>('/settlements/import/retailers'),

  /** Sube un Excel de liquidación / transacciones */
  importSettlement: async (retailerCode: string, file: File): Promise<SettlementImportResult> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_URL}/settlements/import/${retailerCode}`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    return handle<SettlementImportResult>(res);
  },

    /** Productos master */
  listProducts: () => request<Product[]>('/products'),
  createProduct: (data: ProductInput) =>
    request<Product>('/products', { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (id: string, data: Partial<ProductInput>) =>
    request<Product>(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProduct: (id: string) => request<{ deleted: boolean }>(`/products/${id}`, { method: 'DELETE' }),

  /** Insumos */
  listSupplies: () => request<Supply[]>('/supplies'),
  createSupply: (data: SupplyInput) =>
    request<Supply>('/supplies', { method: 'POST', body: JSON.stringify(data) }),
  updateSupply: (id: string, data: Partial<SupplyInput>) =>
    request<Supply>(`/supplies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSupply: (id: string) => request<{ deleted: boolean }>(`/supplies/${id}`, { method: 'DELETE' }),

    /** Catálogo retail */
  catalogRetailers: () => request<CatalogRetailer[]>('/catalog/retailers'),
  listCatalog: (retailerCode: string) => request<CatalogRow[]>(`/catalog?retailer=${retailerCode}`),
  importCatalog: async (retailerCode: string, file: File): Promise<CatalogImportResult> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_URL}/catalog/import/${retailerCode}`, { method: 'POST', body: form, credentials: 'include' });
    return handle<CatalogImportResult>(res);
  },
  /** Asigna un master a varios productos del catálogo (null = quitarlo) */
  assignMaster: (ids: string[], productId: string | null) =>
    request<{ updated: number }>('/catalog/assign', {
      method: 'POST',
      body: JSON.stringify({ ids, productId }),
    }),
    /** Desde la conciliación: une un producto (sin catálogo o sin master) a un master */
  manualCatalogAssign: (data: { retailerCode: string; sellerSku: string | null; name: string; productId: string }) =>
    request<{ created: boolean; updated: number }>('/catalog/manual', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteCatalogItems: (ids: string[]) =>
    request<{ deleted: number }>('/catalog/delete', { method: 'POST', body: JSON.stringify({ ids }) }),

    /** Reporte: productos más vendidos. Fechas AAAA-MM-DD opcionales */
  topProducts: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return request<TopProductsReport>(`/reports/top-products${qs ? `?${qs}` : ''}`);
  },


    /** Dashboard de Inicio. Fechas AAAA-MM-DD opcionales */
  dashboard: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return request<Dashboard>(`/reports/dashboard${qs ? `?${qs}` : ''}`);
  },

    /** Documentos de compra (facturas del proveedor) */
  suppliers: () => request<Supplier[]>('/purchases/suppliers'),
  createPurchaseDocument: (data: NewPurchaseDocument) =>
    request<{ documentId: string; supplier: string; documentNumber: string; lines: number }>(
      '/purchases/documents',
      { method: 'POST', body: JSON.stringify(data) },
    ),
    /** Facturas de proveedores y sus pagos */
  listInvoices: () => request<PurchaseInvoice[]>('/purchases/invoices'),
  siiPurchases: (month: string) => request<SiiPurchasesPreview>(`/sii/compras?month=${month}`),
  importSiiPurchases: (month: string, keys: string[]) =>
    request<{ created: number; linked: number; updated: number }>('/sii/compras/importar', {
      method: 'POST',
      body: JSON.stringify({ month, keys }),
    }),
  getInvoice: (id: string) => request<PurchaseInvoiceDetail>(`/purchases/invoices/${id}`),
  setInvoiceDate: (id: string, issueDate: string) =>
    request<{ ok: boolean }>(`/purchases/invoices/${id}`, { method: 'PATCH', body: JSON.stringify({ issueDate }) }),
  addInvoicePayment: (id: string, data: { amount: string; paidAt: string; method: string | null; note: string | null }) =>
    request<{ id: string }>(`/purchases/invoices/${id}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  deleteInvoicePayment: (paymentId: string) =>
    request<{ deleted: boolean }>(`/purchases/payments/${paymentId}`, { method: 'DELETE' }),
  deletePurchaseLine: (lineId: string) =>
    request<{ deleted: boolean; documentDeleted: boolean }>(`/purchases/lines/${lineId}`, { method: 'DELETE' }),

  /** Cruce de ventas vs liquidación de un retailer */
  reconcile: (retailerCode: string) =>
    request<ReconciliationResult>(`/reconciliation/${retailerCode}`),
};