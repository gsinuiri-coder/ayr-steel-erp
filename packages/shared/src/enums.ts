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
