import type { Currency } from '@ayr/shared';

/**
 * Formateo para mostrar. Los valores llegan del API como string con su escala fija
 * (D-003): acá solo se les da forma, **nunca** se opera con ellos como `number`.
 */

const SYMBOL: Record<Currency, string> = { PEN: 'S/', USD: 'US$' };

/** `"1234.5600"` → `"S/ 1,234.56"`. Redondea a 2 decimales solo para la vista. */
export function formatMoney(value: string, currency: Currency = 'PEN'): string {
  const [intPart = '0', decPart = ''] = value.replace('-', '').split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = `${decPart}00`.slice(0, 2);
  const sign = value.startsWith('-') ? '-' : '';
  return `${sign}${SYMBOL[currency]} ${grouped}.${cents}`;
}

/** `"4500.000"` → `"4,500.000 kg"` (o la unidad que se pase). */
export function formatQty(value: string, unit?: string): string {
  const [intPart = '0', decPart] = value.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = decPart ? `${grouped}.${decPart}` : grouped;
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
