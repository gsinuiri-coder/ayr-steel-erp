/**
 * Roles del sistema (RF-02). Cada usuario tiene exactamente uno.
 * Deben coincidir con el enum `Role` de Prisma.
 */
export const Role = {
  ADMINISTRADOR: 'ADMINISTRADOR',
  SUPERVISOR_PLANTA: 'SUPERVISOR_PLANTA',
  VENDEDOR: 'VENDEDOR',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLES = Object.values(Role) as [Role, ...Role[]];

export const ROLE_LABELS: Record<Role, string> = {
  ADMINISTRADOR: 'Administrador',
  SUPERVISOR_PLANTA: 'Supervisor de planta',
  VENDEDOR: 'Vendedor',
};

/**
 * Líneas de negocio (§2.2). El identificador es el valor persistido.
 * `services` no tiene stock (estrategia `noop`).
 */
export const BusinessLine = {
  DRYWALL: 'drywall',
  METALLIC_ROOFING: 'metallic-roofing',
  ROOFING: 'roofing',
  TRADING: 'trading',
  SERVICES: 'services',
} as const;
export type BusinessLine = (typeof BusinessLine)[keyof typeof BusinessLine];
export const BUSINESS_LINES = Object.values(BusinessLine) as [BusinessLine, ...BusinessLine[]];

export const BUSINESS_LINE_LABELS: Record<BusinessLine, string> = {
  drywall: 'Drywall',
  'metallic-roofing': 'Metallic Roofing',
  roofing: 'Roofing (UPVC)',
  trading: 'Trading',
  services: 'Services',
};

/** Líneas cuyo inventario no genera movimientos de kardex. */
export const NOOP_INVENTORY_LINES: readonly BusinessLine[] = [BusinessLine.SERVICES];

/** Estrategia de inventario de una línea de negocio (tabla `business_lines`, D-034). */
export const InventoryStrategy = {
  STOCK: 'STOCK',
  NOOP: 'NOOP',
} as const;
export type InventoryStrategy = (typeof InventoryStrategy)[keyof typeof InventoryStrategy];
export const INVENTORY_STRATEGIES = Object.values(InventoryStrategy) as [
  InventoryStrategy,
  ...InventoryStrategy[],
];

/** Estrategia por defecto de cada línea al sembrarlas (§2.2): solo `services` es `NOOP`. */
export const DEFAULT_INVENTORY_STRATEGY: Record<BusinessLine, InventoryStrategy> = {
  drywall: InventoryStrategy.STOCK,
  'metallic-roofing': InventoryStrategy.STOCK,
  roofing: InventoryStrategy.STOCK,
  trading: InventoryStrategy.STOCK,
  services: InventoryStrategy.NOOP,
};

/** Moneda de compras y ventas (D-029/P-06). PEN es el default. */
export const Currency = {
  PEN: 'PEN',
  USD: 'USD',
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];
export const CURRENCIES = Object.values(Currency) as [Currency, ...Currency[]];
export const CURRENCY_LABELS: Record<Currency, string> = {
  PEN: 'Soles (PEN)',
  USD: 'Dólares (USD)',
};

/** Origen del tipo de cambio guardado en `exchange_rates` (D-029). */
export const ExchangeRateSource = {
  API: 'API',
  MANUAL: 'MANUAL',
} as const;
export type ExchangeRateSource = (typeof ExchangeRateSource)[keyof typeof ExchangeRateSource];
export const EXCHANGE_RATE_SOURCES = Object.values(ExchangeRateSource) as [
  ExchangeRateSource,
  ...ExchangeRateSource[],
];

/** Origen de un producto del catálogo (§4.5). */
export const ProductSource = {
  MANUFACTURED: 'MANUFACTURED',
  PURCHASED: 'PURCHASED',
} as const;
export type ProductSource = (typeof ProductSource)[keyof typeof ProductSource];
export const PRODUCT_SOURCES = Object.values(ProductSource) as [ProductSource, ...ProductSource[]];
export const PRODUCT_SOURCE_LABELS: Record<ProductSource, string> = {
  MANUFACTURED: 'Fabricado',
  PURCHASED: 'Comprado',
};

/** Tipo de documento de identidad/tributario (RF-80/RF-81). */
export const DocType = {
  DNI: 'DNI',
  RUC: 'RUC',
  CE: 'CE',
} as const;
export type DocType = (typeof DocType)[keyof typeof DocType];
export const DOC_TYPES = Object.values(DocType) as [DocType, ...DocType[]];
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  DNI: 'DNI',
  RUC: 'RUC',
  CE: 'Carné de extranjería',
};

/** Entidad destino de una importación masiva (RF-52; base para RF-12/RF-71). */
export const ImportEntity = {
  PRODUCTS: 'PRODUCTS',
  CUSTOMERS: 'CUSTOMERS',
  COILS: 'COILS',
} as const;
export type ImportEntity = (typeof ImportEntity)[keyof typeof ImportEntity];
export const IMPORT_ENTITIES = Object.values(ImportEntity) as [ImportEntity, ...ImportEntity[]];
export const IMPORT_ENTITY_LABELS: Record<ImportEntity, string> = {
  PRODUCTS: 'Catálogo (productos)',
  CUSTOMERS: 'Clientes',
  COILS: 'Bobinas',
};

/** Estado de una fila dentro de un lote de importación. */
export const ImportRowStatus = {
  VALID: 'VALID',
  INVALID: 'INVALID',
  CONFIRMED: 'CONFIRMED',
} as const;
export type ImportRowStatus = (typeof ImportRowStatus)[keyof typeof ImportRowStatus];
export const IMPORT_ROW_STATUSES = Object.values(ImportRowStatus) as [
  ImportRowStatus,
  ...ImportRowStatus[],
];

/** Estado de un lote de importación completo. */
export const ImportBatchStatus = {
  PARSED: 'PARSED',
  CONFIRMED: 'CONFIRMED',
} as const;
export type ImportBatchStatus = (typeof ImportBatchStatus)[keyof typeof ImportBatchStatus];
export const IMPORT_BATCH_STATUSES = Object.values(ImportBatchStatus) as [
  ImportBatchStatus,
  ...ImportBatchStatus[],
];

// ---------------------------------------------------------------------------
// Fase 2a — kardex (§3.2), compras (D-030) y bobinas (RF-10..RF-14)
// ---------------------------------------------------------------------------

/** Qué clase de ítem mueve el kardex (§3.2). */
export const InventoryItemType = {
  PRODUCT: 'PRODUCT',
  COIL: 'COIL',
} as const;
export type InventoryItemType = (typeof InventoryItemType)[keyof typeof InventoryItemType];
export const INVENTORY_ITEM_TYPES = Object.values(InventoryItemType) as [
  InventoryItemType,
  ...InventoryItemType[],
];
export const INVENTORY_ITEM_TYPE_LABELS: Record<InventoryItemType, string> = {
  PRODUCT: 'Producto',
  COIL: 'Bobina',
};

/** Sentido del movimiento de kardex. La cantidad siempre es positiva. */
export const InventoryMovementType = {
  IN: 'IN',
  OUT: 'OUT',
  ADJUST: 'ADJUST',
} as const;
export type InventoryMovementType =
  (typeof InventoryMovementType)[keyof typeof InventoryMovementType];
export const INVENTORY_MOVEMENT_TYPES = Object.values(InventoryMovementType) as [
  InventoryMovementType,
  ...InventoryMovementType[],
];
export const INVENTORY_MOVEMENT_TYPE_LABELS: Record<InventoryMovementType, string> = {
  IN: 'Entrada',
  OUT: 'Salida',
  ADJUST: 'Ajuste',
};

/** Qué originó el movimiento de kardex. Varios valores se emiten recién en fases posteriores. */
export const InventoryRefType = {
  PURCHASE: 'PURCHASE',
  SALE: 'SALE',
  PRODUCTION: 'PRODUCTION',
  SPLIT: 'SPLIT',
  SCRAP: 'SCRAP',
  CUTTING: 'CUTTING',
  ADJUSTMENT: 'ADJUSTMENT',
  IMPORT: 'IMPORT',
} as const;
export type InventoryRefType = (typeof InventoryRefType)[keyof typeof InventoryRefType];
export const INVENTORY_REF_TYPES = Object.values(InventoryRefType) as [
  InventoryRefType,
  ...InventoryRefType[],
];
export const INVENTORY_REF_TYPE_LABELS: Record<InventoryRefType, string> = {
  PURCHASE: 'Compra',
  SALE: 'Venta',
  PRODUCTION: 'Producción',
  SPLIT: 'Partido de bobina',
  SCRAP: 'Merma',
  CUTTING: 'Corte tercerizado',
  ADJUSTMENT: 'Ajuste manual',
  IMPORT: 'Carga inicial',
};

/** Tipo de compra (D-030). Determina el formulario y qué pasa al recibirla. */
export const PurchaseType = {
  COIL: 'COIL',
  FINISHED_GOOD: 'FINISHED_GOOD',
  SERVICE: 'SERVICE',
  EXPENSE: 'EXPENSE',
} as const;
export type PurchaseType = (typeof PurchaseType)[keyof typeof PurchaseType];
export const PURCHASE_TYPES = Object.values(PurchaseType) as [PurchaseType, ...PurchaseType[]];
export const PURCHASE_TYPE_LABELS: Record<PurchaseType, string> = {
  COIL: 'Bobinas',
  FINISHED_GOOD: 'Producto terminado',
  SERVICE: 'Servicio',
  EXPENSE: 'Gasto',
};

/** Tipos de compra que mueven inventario al recibirse (D-030: EXPENSE nunca lo hace). */
export const STOCK_PURCHASE_TYPES: readonly PurchaseType[] = [
  PurchaseType.COIL,
  PurchaseType.FINISHED_GOOD,
];

/** Comprobante de compra (catálogo 01 de SUNAT). */
export const PurchaseDocType = {
  FACTURA: 'FACTURA',
  BOLETA: 'BOLETA',
  NOTA_CREDITO: 'NOTA_CREDITO',
  NOTA_DEBITO: 'NOTA_DEBITO',
} as const;
export type PurchaseDocType = (typeof PurchaseDocType)[keyof typeof PurchaseDocType];
export const PURCHASE_DOC_TYPES = Object.values(PurchaseDocType) as [
  PurchaseDocType,
  ...PurchaseDocType[],
];
export const PURCHASE_DOC_TYPE_LABELS: Record<PurchaseDocType, string> = {
  FACTURA: 'Factura',
  BOLETA: 'Boleta',
  NOTA_CREDITO: 'Nota de crédito',
  NOTA_DEBITO: 'Nota de débito',
};

/** Condición de pago de una compra (D-039). */
export const PaymentTerms = {
  CONTADO: 'CONTADO',
  CREDITO: 'CREDITO',
} as const;
export type PaymentTerms = (typeof PaymentTerms)[keyof typeof PaymentTerms];
export const PAYMENT_TERMS = Object.values(PaymentTerms) as [PaymentTerms, ...PaymentTerms[]];
export const PAYMENT_TERMS_LABELS: Record<PaymentTerms, string> = {
  CONTADO: 'Contado',
  CREDITO: 'Crédito',
};

/** Estado de una compra (D-030). */
export const PurchaseStatus = {
  DRAFT: 'DRAFT',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];
export const PURCHASE_STATUSES = Object.values(PurchaseStatus) as [
  PurchaseStatus,
  ...PurchaseStatus[],
];
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: 'Borrador',
  RECEIVED: 'Recibida',
  CANCELLED: 'Anulada',
};

/** Naturaleza de una compra de servicio (RF-41, D-043). */
export const ServiceKind = {
  CUTTING: 'CUTTING',
  FREIGHT: 'FREIGHT',
  CUSTOMS: 'CUSTOMS',
  INSURANCE: 'INSURANCE',
  OTHER: 'OTHER',
} as const;
export type ServiceKind = (typeof ServiceKind)[keyof typeof ServiceKind];
export const SERVICE_KINDS = Object.values(ServiceKind) as [ServiceKind, ...ServiceKind[]];
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  CUTTING: 'Corte tercerizado',
  FREIGHT: 'Flete',
  CUSTOMS: 'Aduanas',
  INSURANCE: 'Seguro',
  OTHER: 'Otro servicio',
};

/**
 * Servicios que se pueden imputar al costo de una compra de bobinas (landed cost,
 * D-043). `CUTTING` prorratea por otro criterio y es de Fase 3; `OTHER` no se imputa.
 */
export const LANDED_COST_SERVICE_KINDS: readonly ServiceKind[] = [
  ServiceKind.FREIGHT,
  ServiceKind.CUSTOMS,
  ServiceKind.INSURANCE,
];

/**
 * Medio de pago (D-039 para el pago a proveedor, D-075 para el cobro a cliente).
 *
 * `CARD` y `WALLET` los agrega el mostrador (Fase 7b, D-101). No son un enum aparte a
 * propósito: un cobro de mostrador es un cobro como cualquier otro —la misma tabla, el
 * mismo saldo, la misma reversa— y lo único que cambia es por dónde entró el dinero.
 * Qué medios ofrece cada pantalla lo decide `POS_PAYMENT_METHODS` en `schemas/pos`,
 * no el enum.
 */
export const PaymentMethod = {
  CASH: 'CASH',
  TRANSFER: 'TRANSFER',
  CHECK: 'CHECK',
  DEPOSIT: 'DEPOSIT',
  CARD: 'CARD',
  WALLET: 'WALLET',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PAYMENT_METHODS = Object.values(PaymentMethod) as [PaymentMethod, ...PaymentMethod[]];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
  CHECK: 'Cheque',
  DEPOSIT: 'Depósito',
  CARD: 'Tarjeta',
  WALLET: 'Yape / Plin',
  OTHER: 'Otro',
};

/**
 * Estado de una bobina (RF-19, RF-21). `IN_THIRD_PARTY` (D-050, Fase 3): la bobina está
 * en poder de un proveedor de corte tercerizado; sigue en el kardex de la empresa pero
 * no entra a producción ni a partido local (RF-15) hasta que vuelve.
 */
export const CoilStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  IN_THIRD_PARTY: 'IN_THIRD_PARTY',
} as const;
export type CoilStatus = (typeof CoilStatus)[keyof typeof CoilStatus];
export const COIL_STATUSES = Object.values(CoilStatus) as [CoilStatus, ...CoilStatus[]];
export const COIL_STATUS_LABELS: Record<CoilStatus, string> = {
  OPEN: 'Abierta',
  CLOSED: 'Cerrada',
  CANCELLED: 'Anulada',
  IN_THIRD_PARTY: 'En corte tercerizado',
};

/** Clase de fila de `coils` (D-049). Un fleje es una bobina `STRIP`. */
export const CoilKind = {
  COIL: 'COIL',
  STRIP: 'STRIP',
} as const;
export type CoilKind = (typeof CoilKind)[keyof typeof CoilKind];
export const COIL_KINDS = Object.values(CoilKind) as [CoilKind, ...CoilKind[]];
export const COIL_KIND_LABELS: Record<CoilKind, string> = {
  COIL: 'Bobina',
  STRIP: 'Fleje',
};

/** Estado de un partido de bobina (RF-15/RF-16). */
export const CoilSplitStatus = {
  ACTIVE: 'ACTIVE',
  REVERTED: 'REVERTED',
} as const;
export type CoilSplitStatus = (typeof CoilSplitStatus)[keyof typeof CoilSplitStatus];
export const COIL_SPLIT_STATUSES = Object.values(CoilSplitStatus) as [
  CoilSplitStatus,
  ...CoilSplitStatus[],
];
export const COIL_SPLIT_STATUS_LABELS: Record<CoilSplitStatus, string> = {
  ACTIVE: 'Vigente',
  REVERTED: 'Revertido',
};

/**
 * Unidades de medida del catálogo 03 de SUNAT (basado en UN/ECE rec. 20) que usa el
 * ERP. Detalle y fuente en `docs/referencias/ubl21-factura.md`.
 */
export const Unit = {
  /** Kilogramo: bobinas y todo lo que se compra/vende por peso. */
  KGM: 'KGM',
  /** Unidad (item): productos contables del catálogo. */
  NIU: 'NIU',
  /** Metro lineal. */
  MTR: 'MTR',
  /** Tonelada métrica. */
  TNE: 'TNE',
  /** Servicio / no aplica una unidad física. */
  ZZ: 'ZZ',
} as const;
export type Unit = (typeof Unit)[keyof typeof Unit];
export const UNITS = Object.values(Unit) as [Unit, ...Unit[]];
export const UNIT_LABELS: Record<Unit, string> = {
  KGM: 'Kilogramo (KGM)',
  NIU: 'Unidad (NIU)',
  MTR: 'Metro (MTR)',
  TNE: 'Tonelada (TNE)',
  ZZ: 'Servicio (ZZ)',
};

// ---------------------------------------------------------------------------
// Fase 3 — corte tercerizado y flejes (RF-40..42, D-049/D-050)
// ---------------------------------------------------------------------------

/**
 * Estado de una orden de corte tercerizado. `PARTIALLY_RECEIVED` mientras conviven
 * bobinas `SENT` y `RECEIVED`; `RECEIVED` cuando ya no queda ninguna `SENT` (recibida o
 * cancelada); `CANCELLED` solo si ninguna bobina llegó a recibirse.
 */
export const CuttingOrderStatus = {
  SENT: 'SENT',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type CuttingOrderStatus = (typeof CuttingOrderStatus)[keyof typeof CuttingOrderStatus];
export const CUTTING_ORDER_STATUSES = Object.values(CuttingOrderStatus) as [
  CuttingOrderStatus,
  ...CuttingOrderStatus[],
];
export const CUTTING_ORDER_STATUS_LABELS: Record<CuttingOrderStatus, string> = {
  SENT: 'Enviada',
  PARTIALLY_RECEIVED: 'Recepción parcial',
  RECEIVED: 'Recibida',
  CANCELLED: 'Anulada',
};

/** Estado de una bobina dentro de una orden de corte. */
export const CuttingOrderCoilStatus = {
  SENT: 'SENT',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type CuttingOrderCoilStatus =
  (typeof CuttingOrderCoilStatus)[keyof typeof CuttingOrderCoilStatus];
export const CUTTING_ORDER_COIL_STATUSES = Object.values(CuttingOrderCoilStatus) as [
  CuttingOrderCoilStatus,
  ...CuttingOrderCoilStatus[],
];
export const CUTTING_ORDER_COIL_STATUS_LABELS: Record<CuttingOrderCoilStatus, string> = {
  SENT: 'Enviada',
  RECEIVED: 'Recibida',
  CANCELLED: 'Anulada',
};

// ---------------------------------------------------------------------------
// Fase 4 — producción de drywall (RF-32..35, RF-38, RF-39, D-055..D-060)
// ---------------------------------------------------------------------------

/**
 * Estado de una orden de producción (D-058). `DRAFT` mientras no tiene ningún fleje
 * asignado; `IN_PROGRESS` desde el primero. `CLOSED` y `CANCELLED` son terminales.
 */
export const ProductionOrderStatus = {
  DRAFT: 'DRAFT',
  IN_PROGRESS: 'IN_PROGRESS',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;
export type ProductionOrderStatus =
  (typeof ProductionOrderStatus)[keyof typeof ProductionOrderStatus];
export const PRODUCTION_ORDER_STATUSES = Object.values(ProductionOrderStatus) as [
  ProductionOrderStatus,
  ...ProductionOrderStatus[],
];
export const PRODUCTION_ORDER_STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  DRAFT: 'Borrador',
  IN_PROGRESS: 'En proceso',
  CLOSED: 'Cerrada',
  CANCELLED: 'Anulada',
};

/**
 * Qué línea de transformación fabrica una orden (D-087). `DRYWALL` consume flejes contra
 * una receta de largo fijo y reporta piezas; `ROOFING` consume bobina, reporta los largos
 * reales del pedido y lleva el producto a medida en metros lineales (D-083).
 */
export const ProductionOrderKind = {
  DRYWALL: 'DRYWALL',
  ROOFING: 'ROOFING',
} as const;
export type ProductionOrderKind = (typeof ProductionOrderKind)[keyof typeof ProductionOrderKind];
export const PRODUCTION_ORDER_KINDS = Object.values(ProductionOrderKind) as [
  ProductionOrderKind,
  ...ProductionOrderKind[],
];
export const PRODUCTION_ORDER_KIND_LABELS: Record<ProductionOrderKind, string> = {
  DRYWALL: 'Perfiles de drywall',
  ROOFING: 'Coberturas metálicas',
};

/** Qué clase de receta es (D-087). La misma tabla sirve a las dos líneas. */
export const ProductBomKind = {
  DRYWALL: 'DRYWALL',
  ROOFING: 'ROOFING',
} as const;
export type ProductBomKind = (typeof ProductBomKind)[keyof typeof ProductBomKind];
export const PRODUCT_BOM_KINDS = Object.values(ProductBomKind) as [
  ProductBomKind,
  ...ProductBomKind[],
];
export const PRODUCT_BOM_KIND_LABELS: Record<ProductBomKind, string> = {
  DRYWALL: 'Perfil de drywall (desde fleje)',
  ROOFING: 'Cobertura metálica (desde bobina)',
};

/** Estado de un reporte de piezas dentro de una OP (D-060). */
export const ProductionReportStatus = {
  ACTIVE: 'ACTIVE',
  REVERTED: 'REVERTED',
} as const;
export type ProductionReportStatus =
  (typeof ProductionReportStatus)[keyof typeof ProductionReportStatus];
export const PRODUCTION_REPORT_STATUSES = Object.values(ProductionReportStatus) as [
  ProductionReportStatus,
  ...ProductionReportStatus[],
];
export const PRODUCTION_REPORT_STATUS_LABELS: Record<ProductionReportStatus, string> = {
  ACTIVE: 'Vigente',
  REVERTED: 'Revertido',
};

/** `123` → `OP-000123`. Correlativo legible de una orden de producción. */
export function productionOrderCode(seq: number): string {
  return `OP-${String(seq).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Fase 5a — cotización, pedido y reserva (RF-61, RF-62, RF-65, RF-69; D-064..D-069)
// ---------------------------------------------------------------------------

/**
 * Estado de una cotización (D-069). `DRAFT` mientras el vendedor la arma; `EMITTED`
 * cuando ya se le mandó al cliente (es el único estado desde el que se confirma);
 * `CONFIRMED` cuando generó pedido y reserva. `EXPIRED` lo pone el job diario al pasar
 * `validUntil`; `CANCELLED` es la anulación manual. Los tres últimos son terminales,
 * salvo que anular el pedido devuelva la cotización a `EMITTED` si sigue vigente.
 */
export const QuotationStatus = {
  DRAFT: 'DRAFT',
  EMITTED: 'EMITTED',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type QuotationStatus = (typeof QuotationStatus)[keyof typeof QuotationStatus];
export const QUOTATION_STATUSES = Object.values(QuotationStatus) as [
  QuotationStatus,
  ...QuotationStatus[],
];
export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  DRAFT: 'Borrador',
  EMITTED: 'Emitida',
  CONFIRMED: 'Confirmada',
  EXPIRED: 'Vencida',
  CANCELLED: 'Anulada',
};

/**
 * Estado de un pedido (D-065). Estados mínimos de Fase 5a: el despacho real, la guía y
 * la cobranza son de Fase 5b. `IN_PRODUCTION` desde que una OP nace del pedido;
 * `FULFILLED` cuando se entregó todo.
 */
export const SalesOrderStatus = {
  CONFIRMED: 'CONFIRMED',
  IN_PRODUCTION: 'IN_PRODUCTION',
  /// D-074: hay mercadería despachada y todavía queda pendiente en alguna línea.
  PARTIALLY_FULFILLED: 'PARTIALLY_FULFILLED',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
} as const;
export type SalesOrderStatus = (typeof SalesOrderStatus)[keyof typeof SalesOrderStatus];
export const SALES_ORDER_STATUSES = Object.values(SalesOrderStatus) as [
  SalesOrderStatus,
  ...SalesOrderStatus[],
];
export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  CONFIRMED: 'Confirmado',
  IN_PRODUCTION: 'En producción',
  PARTIALLY_FULFILLED: 'Atendido en parte',
  FULFILLED: 'Atendido',
  CANCELLED: 'Anulado',
};

/**
 * Estado de una reserva de stock (D-054, D-066). `ACTIVE` es la única que descuenta
 * disponible y la única que bloquea operaciones sobre el ítem; `CONSUMED` la marca la OP
 * al emitir material; `RELEASED` sale de anular el pedido o de la liberación manual.
 */
export const ReservationStatus = {
  ACTIVE: 'ACTIVE',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];
export const RESERVATION_STATUSES = Object.values(ReservationStatus) as [
  ReservationStatus,
  ...ReservationStatus[],
];
export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  ACTIVE: 'Activa',
  CONSUMED: 'Consumida',
  RELEASED: 'Liberada',
};

/** `123` → `COT-000123`. Correlativo legible de una cotización (D-068). */
export function quotationCode(seq: number): string {
  return `COT-${String(seq).padStart(6, '0')}`;
}

/** `123` → `PED-000123`. Correlativo legible de un pedido (D-068). */
export function salesOrderCode(seq: number): string {
  return `PED-${String(seq).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Fase 5b — documentos electrónicos, despacho y cobranza (D-070..D-078)
// ---------------------------------------------------------------------------

/**
 * Tipo de documento electrónico que **emitimos**. Espejo de `FiscalDocType` en Prisma.
 *
 * No se confunde con `PurchaseDocType`, que describe lo que nos emitieron a nosotros y
 * admite nota de débito: la de venta está diferida (D-070).
 */
export const FiscalDocType = {
  FACTURA: 'FACTURA',
  BOLETA: 'BOLETA',
  NOTA_CREDITO: 'NOTA_CREDITO',
  GUIA_REMISION_REMITENTE: 'GUIA_REMISION_REMITENTE',
} as const;
export type FiscalDocType = (typeof FiscalDocType)[keyof typeof FiscalDocType];
export const FISCAL_DOC_TYPES = Object.values(FiscalDocType) as [FiscalDocType, ...FiscalDocType[]];

/** Los tres que llevan importes y líneas. La guía no es un comprobante de pago. */
export const INVOICE_DOC_TYPES = [
  FiscalDocType.FACTURA,
  FiscalDocType.BOLETA,
  FiscalDocType.NOTA_CREDITO,
] as [FiscalDocType, ...FiscalDocType[]];

export const FISCAL_DOC_TYPE_LABELS: Record<FiscalDocType, string> = {
  FACTURA: 'Factura',
  BOLETA: 'Boleta de venta',
  NOTA_CREDITO: 'Nota de crédito',
  GUIA_REMISION_REMITENTE: 'Guía de remisión remitente',
};

/**
 * Estado de un documento electrónico (D-073). La UI los llama BORRADOR / EMITIDO /
 * ACEPTADO / RECHAZADO / ERROR DE ENVÍO / BAJA EN TRÁMITE / ANULADO.
 *
 * `ISSUED` es el estado de contingencia: correlativo ya tomado, PSE todavía sin
 * responder, y **el despacho ya habilitado**. `REJECTED` es terminal — se corrige y se
 * reemite con un correlativo nuevo (D-072).
 */
export const FiscalDocumentStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  SEND_ERROR: 'SEND_ERROR',
  VOID_PENDING: 'VOID_PENDING',
  VOIDED: 'VOIDED',
} as const;
export type FiscalDocumentStatus = (typeof FiscalDocumentStatus)[keyof typeof FiscalDocumentStatus];
export const FISCAL_DOCUMENT_STATUSES = Object.values(FiscalDocumentStatus) as [
  FiscalDocumentStatus,
  ...FiscalDocumentStatus[],
];
export const FISCAL_DOCUMENT_STATUS_LABELS: Record<FiscalDocumentStatus, string> = {
  DRAFT: 'Borrador',
  ISSUED: 'Emitido (pendiente de envío)',
  ACCEPTED: 'Aceptado',
  REJECTED: 'Rechazado',
  SEND_ERROR: 'Error de envío',
  VOID_PENDING: 'Baja en trámite',
  VOIDED: 'Anulado',
};

/**
 * Estados desde los que el job de D-073 vuelve a intentar el envío. `ISSUED` es el que
 * nunca salió; `SEND_ERROR`, el que salió y no entró.
 */
export const RETRYABLE_DOCUMENT_STATUSES: readonly FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
];

/** Motivo de una nota de crédito (catálogo 09 de SUNAT). */
export const CreditNoteReason = {
  ANULACION_OPERACION: 'ANULACION_OPERACION',
  ANULACION_ERROR_RUC: 'ANULACION_ERROR_RUC',
  CORRECCION_DESCRIPCION: 'CORRECCION_DESCRIPCION',
  DESCUENTO_GLOBAL: 'DESCUENTO_GLOBAL',
  DESCUENTO_ITEM: 'DESCUENTO_ITEM',
  DEVOLUCION_TOTAL: 'DEVOLUCION_TOTAL',
  DEVOLUCION_ITEM: 'DEVOLUCION_ITEM',
  OTROS_AJUSTES: 'OTROS_AJUSTES',
} as const;
export type CreditNoteReason = (typeof CreditNoteReason)[keyof typeof CreditNoteReason];
export const CREDIT_NOTE_REASONS = Object.values(CreditNoteReason) as [
  CreditNoteReason,
  ...CreditNoteReason[],
];
export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string> = {
  ANULACION_OPERACION: 'Anulación de la operación',
  ANULACION_ERROR_RUC: 'Anulación por error en el RUC',
  CORRECCION_DESCRIPCION: 'Corrección por error en la descripción',
  DESCUENTO_GLOBAL: 'Descuento global',
  DESCUENTO_ITEM: 'Descuento por ítem',
  DEVOLUCION_TOTAL: 'Devolución total',
  DEVOLUCION_ITEM: 'Devolución por ítem',
  OTROS_AJUSTES: 'Otros ajustes de monto',
};
export const CREDIT_NOTE_REASON_SUNAT_CODE: Record<CreditNoteReason, string> = {
  ANULACION_OPERACION: '01',
  ANULACION_ERROR_RUC: '02',
  CORRECCION_DESCRIPCION: '03',
  DESCUENTO_GLOBAL: '04',
  DESCUENTO_ITEM: '05',
  DEVOLUCION_TOTAL: '06',
  DEVOLUCION_ITEM: '07',
  OTROS_AJUSTES: '13',
};

/**
 * Motivos que anulan la operación completa. Solo con uno de estos tiene sentido una nota
 * de crédito **total**; los de descuento y devolución parcial piden líneas.
 */
export const FULL_CREDIT_NOTE_REASONS: readonly CreditNoteReason[] = [
  CreditNoteReason.ANULACION_OPERACION,
  CreditNoteReason.ANULACION_ERROR_RUC,
  CreditNoteReason.DEVOLUCION_TOTAL,
];

/** Modalidad de traslado (catálogo 18 de SUNAT, D-078). Se elige por despacho. */
export const TransferMode = {
  PRIVATE: 'PRIVATE',
  PUBLIC: 'PUBLIC',
  /**
   * Recojo en mostrador (Fase 7b, D-103): el comprador se lleva la mercadería del
   * mostrador. No hay vehículo nuestro ni transportista contratado, así que **no hay guía
   * de remisión remitente que emitir** —el traslado es del comprador— y por eso este modo
   * no tiene código de SUNAT: nunca viaja al PSE.
   */
  PICKUP: 'PICKUP',
} as const;
export type TransferMode = (typeof TransferMode)[keyof typeof TransferMode];
export const TRANSFER_MODES = Object.values(TransferMode) as [TransferMode, ...TransferMode[]];
export const TRANSFER_MODE_LABELS: Record<TransferMode, string> = {
  PRIVATE: 'Transporte privado (vehículo propio)',
  PUBLIC: 'Transporte público (transportista)',
  PICKUP: 'Recojo en mostrador (lo lleva el cliente)',
};

/**
 * Modalidades que **pueden** ir en una guía de remisión remitente. `PICKUP` no está: el
 * traslado lo hace el comprador con su propio medio, así que el remitente no emite guía.
 */
export const GRE_TRANSFER_MODES: readonly TransferMode[] = [
  TransferMode.PUBLIC,
  TransferMode.PRIVATE,
];

/** Catálogo 18 de SUNAT. Solo las modalidades que llegan a una guía (ver `GRE_TRANSFER_MODES`). */
export const TRANSFER_MODE_SUNAT_CODE: Record<'PUBLIC' | 'PRIVATE', string> = {
  PUBLIC: '01',
  PRIVATE: '02',
};

/** Estado de un despacho (D-074). Revertir marca la fila, nunca la borra. */
export const DispatchStatus = {
  ISSUED: 'ISSUED',
  REVERSED: 'REVERSED',
} as const;
export type DispatchStatus = (typeof DispatchStatus)[keyof typeof DispatchStatus];
export const DISPATCH_STATUSES = Object.values(DispatchStatus) as [
  DispatchStatus,
  ...DispatchStatus[],
];
export const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = {
  ISSUED: 'Despachado',
  REVERSED: 'Revertido',
};

/**
 * `T001` + `123` → `T001-00000123`. Formato con el que SUNAT identifica un documento:
 * serie de cuatro caracteres, guion, correlativo a ocho dígitos (§2.1 de
 * `docs/referencias/ubl21-factura.md`).
 */
export function fiscalDocumentNumber(series: string, correlative: number): string {
  return `${series}-${String(correlative).padStart(8, '0')}`;
}

/** `123` → `DES-000123`. Correlativo interno de un despacho; no es un número fiscal. */
export function dispatchCode(seq: number): string {
  return `DES-${String(seq).padStart(6, '0')}`;
}
