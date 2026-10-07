import { toDecimal, type Decimal } from '@ayr/shared';
import { formatUnitQty, isPositiveDecimal } from '@/lib/format';

/**
 * cc31 (ESPEC §6, «Nuevo despacho»): la lógica sin DOM del formulario —sumas por unidad,
 * enumeraciones y los mensajes que dicen qué corregir—. Vive aparte para probarla con vitest;
 * no cambia ninguna regla del despacho: las condiciones son las mismas que ya habilitaban el
 * envío (ubigeo de 6 dígitos, cantidad positiva y no mayor que lo pendiente).
 */

export interface UnitSum {
  /** Unidad SUNAT (`NIU`, `MTR`, `KGM`…). */
  unit: string;
  total: Decimal;
}

/** Suma las cantidades por unidad, en el orden en que aparece cada unidad. */
export function sumByUnit(lines: readonly { qty: string; unit: string }[]): UnitSum[] {
  const sums: UnitSum[] = [];
  for (const line of lines) {
    if (!isPositiveDecimal(line.qty)) continue;
    const qty = toDecimal(line.qty.trim());
    const found = sums.find((s) => s.unit === line.unit);
    if (found) found.total = found.total.plus(qty);
    else sums.push({ unit: line.unit, total: qty });
  }
  return sums;
}

/** «a», «a y b», «a, b y c». */
export function joinWithY(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1] ?? ''}`;
}

/** «20 und y 12.00 m». */
export function formatUnitSums(sums: readonly UnitSum[]): string {
  return joinWithY(sums.map((s) => formatUnitQty(s.total.toFixed(), s.unit)));
}

/** Lo que hay que corregir en un ubigeo, o `null` si tiene sus 6 dígitos. */
export function ubigeoError(value: string): string | null {
  const v = value.trim();
  if (/^\d{6}$/.test(v)) return null;
  if (v === '') return 'Escribe el ubigeo: 6 dígitos del distrito.';
  if (!/^\d+$/.test(v)) return 'Solo números: el ubigeo tiene 6 dígitos.';
  return `Deben ser 6 dígitos; van ${String(v.length)}.`;
}

/**
 * Lo que hay que corregir en la cantidad a despachar de una línea, o `null` si está bien o
 * vacía (vacía es «esta línea no sale», no un error).
 */
export function qtyError(raw: string, pending: string, unit: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (!isPositiveDecimal(v)) return 'Escribe una cantidad mayor que cero, con punto decimal.';
  if (toDecimal(v).gt(toDecimal(pending))) {
    return `Quedan ${formatUnitQty(pending, unit)} por despachar.`;
  }
  return null;
}

/** «1 dato por corregir», «3 datos por corregir». */
export function toFixText(count: number, noun: [string, string] = ['dato', 'datos']): string {
  return `${String(count)} ${count === 1 ? noun[0] : noun[1]} por corregir`;
}
