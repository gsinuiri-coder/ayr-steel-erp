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

/** Medio de pago a proveedor (D-039). */
export const PaymentMethod = {
  CASH: 'CASH',
  TRANSFER: 'TRANSFER',
  CHECK: 'CHECK',
  DEPOSIT: 'DEPOSIT',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PAYMENT_METHODS = Object.values(PaymentMethod) as [PaymentMethod, ...PaymentMethod[]];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
  CHECK: 'Cheque',
  DEPOSIT: 'Depósito',
  OTHER: 'Otro',
};

/** Estado de una bobina (RF-19, RF-21). */
export const CoilStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;
export type CoilStatus = (typeof CoilStatus)[keyof typeof CoilStatus];
export const COIL_STATUSES = Object.values(CoilStatus) as [CoilStatus, ...CoilStatus[]];
export const COIL_STATUS_LABELS: Record<CoilStatus, string> = {
  OPEN: 'Abierta',
  CLOSED: 'Cerrada',
  CANCELLED: 'Anulada',
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
