import { CoilKind, CoilStatus, FinishKind, type Prisma } from '@prisma/client';
import type { NoFloorReason } from '@ayr/shared';

/**
 * D-344 — **el fleje compatible con un perfil de drywall**, definido en un solo lugar.
 *
 * Hasta D-343 lo decía la receta del producto (acabado + espesor + ancho de entrada) y el criterio
 * estaba copiado en tres sitios (el piso de precio, `/planta` y la orden de producción). Desde
 * D-344 no hay receta: es del SKU, y esta es la única definición que usan los tres:
 *
 * - `kind = STRIP` (un fleje, no una bobina),
 * - acabado de tipo `GALVANIZADO` (drywall tiene un solo acabado; no se guarda en el SKU),
 * - **espesor exacto** del SKU (drywall no usa la tolerancia de coberturas),
 * - **ancho exacto** del SKU (el ancho del fleje, su desarrollo),
 * - de la línea de negocio del producto.
 */

/** El espesor y el ancho del fleje que un SKU de drywall consume, ya normalizados a 2 decimales. */
export interface DrywallStripSpec {
  thicknessMm: string;
  widthMm: string;
}

/**
 * Lo que un SKU declara del fleje que consume, o el motivo por el que no lo declara. Sin espesor
 * (o sin ancho) no hay manera de saber qué fleje sirve: no hay piso y no se abre una orden.
 */
export function drywallStripSpec(product: {
  thicknessMm: Prisma.Decimal | null;
  widthMm: Prisma.Decimal | null;
}): DrywallStripSpec | { noFloorReason: Extract<NoFloorReason, 'NO_THICKNESS' | 'NO_WIDTH'> } {
  if (product.thicknessMm === null || product.thicknessMm.lte(0)) {
    return { noFloorReason: 'NO_THICKNESS' };
  }
  if (product.widthMm === null || product.widthMm.lte(0)) {
    return { noFloorReason: 'NO_WIDTH' };
  }
  return { thicknessMm: product.thicknessMm.toFixed(2), widthMm: product.widthMm.toFixed(2) };
}

/**
 * El filtro de Prisma de los flejes **abiertos** que sirven a un perfil: los que `/planta` ofrece
 * y con cuyos saldos se calcula el piso. Un fleje anulado, terminado o en poder de un tercero no
 * es material con el que se pueda producir hoy.
 */
export function drywallStripWhere(spec: DrywallStripSpec & { businessLineId: string }) {
  return {
    kind: CoilKind.STRIP,
    status: CoilStatus.OPEN,
    businessLineId: spec.businessLineId,
    finish: { kind: FinishKind.GALVANIZADO },
    thicknessMm: spec.thicknessMm,
    widthMm: spec.widthMm,
  } satisfies Prisma.CoilWhereInput;
}

/** Cómo nombrar el fleje que pide un SKU: los tres datos, para que el error se pueda accionar. */
export function describeDrywallStrip(spec: DrywallStripSpec): string {
  return `un fleje de acabado galvanizado, ${spec.thicknessMm} mm de espesor y ${spec.widthMm} mm de ancho`;
}

/**
 * ¿Este fleje sirve al perfil? La misma regla de `drywallStripWhere`, para validar el que el
 * operario eligió. Devuelve `null` si sirve o el mensaje que nombra lo que pide el SKU.
 */
export function drywallStripMismatch(
  strip: {
    code: string;
    finishKind: FinishKind | null;
    thicknessMm: Prisma.Decimal;
    widthMm: Prisma.Decimal;
  },
  spec: DrywallStripSpec,
): string | null {
  const matches =
    strip.finishKind === FinishKind.GALVANIZADO &&
    strip.thicknessMm.toFixed(2) === spec.thicknessMm &&
    strip.widthMm.toFixed(2) === spec.widthMm;
  if (matches) return null;
  return `${strip.code} no es compatible con el perfil: se necesita ${describeDrywallStrip(spec)} (los datos del SKU)`;
}
