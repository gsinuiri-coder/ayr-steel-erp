import { Decimal, type Currency } from '@ayr/shared';

/**
 * Formateo para mostrar. Los valores llegan del API como string con su escala fija
 * (D-003): acá solo se les da forma. El redondeo se hace con `Decimal`, nunca
 * truncando la cadena, porque un `S/ 3.45` donde el costo real es `3.4567` le da al
 * usuario una cuenta distinta al multiplicarlo por los kilos.
 */

const SYMBOL: Record<Currency, string> = { PEN: 'S/', USD: 'US$' };

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `"1234.5678"` → `"S/ 1,234.57"`. `decimals` sube a 4 para precios unitarios. */
export function formatMoney(value: string, currency: Currency = 'PEN', decimals = 2): string {
  const rounded = new Decimal(value)
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
    .toFixed(decimals);
  const negative = rounded.startsWith('-');
  const [intPart = '0', decPart = ''] = rounded.replace('-', '').split('.');
  return `${negative ? '-' : ''}${SYMBOL[currency]} ${group(intPart)}${decPart ? `.${decPart}` : ''}`;
}

/**
 * Igual que `formatMoney` pero tolera `null`: el API oculta los costos a VENDEDOR
 * (§3.4) devolviéndolos vacíos, y la vista muestra un guion en vez de un cero que se
 * leería como un costo real de S/ 0.00.
 */
export function formatMoneyOrDash(
  value: string | null,
  currency: Currency = 'PEN',
  decimals = 2,
): string {
  return value === null ? '—' : formatMoney(value, currency, decimals);
}

/**
 * Símbolo corto de una unidad SUNAT (catálogo 03) para mostrar junto a una cantidad.
 * El API devuelve el código (`KGM`, `NIU`…), pero en pantalla conviven con los kilos
 * que las tarjetas de bobina escriben a mano: sin este mapa, la misma magnitud se ve
 * como `KGM` en una tabla y como `kg` dos centímetros más arriba.
 */
const UNIT_SYMBOL: Record<string, string> = {
  KGM: 'kg',
  NIU: 'u',
  MTR: 'm',
  TNE: 't',
  ZZ: '',
};

export function unitSymbol(unit: string): string {
  return UNIT_SYMBOL[unit] ?? unit;
}

/** `"4500.000"` → `"4,500.000 kg"` (o la unidad que se pase). */
export function formatQty(value: string, unit?: string): string {
  const [intPart = '0', decPart] = value.split('.');
  const body = decPart ? `${group(intPart)}.${decPart}` : group(intPart);
  return unit ? `${body} ${unit}` : body;
}

/** `"2026-08-20"` → `"20/08/2026"`. Sin `Date` para no arrastrar zonas horarias. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Fecha de hoy en formato ISO corto, para prellenar formularios. */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `true` si la cadena es un decimal válido y positivo, para no mandar basura al API. */
export function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim()) && new Decimal(value.trim()).gt(0);
}
