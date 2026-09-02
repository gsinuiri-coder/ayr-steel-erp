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
} as const;
export type ImportEntity = (typeof ImportEntity)[keyof typeof ImportEntity];
export const IMPORT_ENTITIES = Object.values(ImportEntity) as [ImportEntity, ...ImportEntity[]];
export const IMPORT_ENTITY_LABELS: Record<ImportEntity, string> = {
  PRODUCTS: 'Catálogo (productos)',
  CUSTOMERS: 'Clientes',
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
