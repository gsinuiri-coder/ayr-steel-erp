import { CoilKind, CoilStatus, type Prisma } from '@prisma/client';
import { ROOFING_THICKNESS_TOLERANCE_MM, type Decimal, toDecimal } from '@ayr/shared';
import type { Env } from '../config/env';

/**
 * Qué bobinas puede rolar una cobertura (D-086).
 *
 * Vive en un archivo propio porque ahora lo preguntan **dos** lugares: el selector de la OP
 * (`coilOptions`, planta elige el rollo) y la confirmación de una cotización a medida
 * (D-127, el API elige el rollo cuando el vendedor no lo eligió). Copiar el filtro en el
 * segundo era garantizar que un día divergieran y que la cotización prometiera material que
 * la orden después no puede montar — exactamente la clase de defecto que D-088 y D-097 ya
 * costaron una vez.
 *
 * El criterio: misma línea de negocio, `OPEN`, **mismo color con igualdad estricta** (null
 * incluido: un producto sin color solo monta bobina sin color) y espesor dentro de la
 * tolerancia. El ancho no filtra: la producción usa el del rollo que se monte.
 *
 * D-270: el `colorId` es el **color comercial** (ROJO), no el RAL. El RAL vive en el acabado
 * (`ALZ-ROJO-3002`, `ALZ-ROJO-3020`), así que igualdad de color ya es igualdad de color
 * comercial: dos RAL del mismo color son intercambiables en producción, y el candado del
 * maestro (D-273) impide crear un color que los vuelva a separar.
 */
/**
 * D-271: el orden del selector de planta. El filtro empareja por color comercial, así que una
 * OP de un producto ALZ-ROJO-3020 ve también las bobinas ALZ-ROJO-3002 y las puede montar. Lo
 * que se vendió es el 3020: esas van primero. Se prefiere lo exacto sin bloquear lo demás.
 *
 * Las cerradas siguen al final (D-193: se ven a pedido); dentro de cada grupo se conserva el
 * orden que traían. No filtra nada: ordenar no puede esconder una bobina montable.
 */
export function preferExactFinish<T extends { finishId: string; status: 'OPEN' | 'CLOSED' }>(
  coils: readonly T[],
  productFinishId: string | null,
): (T & { exactFinish: boolean })[] {
  const rank = (c: T & { exactFinish: boolean }): number =>
    (c.status === 'CLOSED' ? 2 : 0) + (c.exactFinish ? 0 : 1);
  return coils
    .map((c, index) => ({
      coil: { ...c, exactFinish: productFinishId !== null && c.finishId === productFinishId },
      index,
    }))
    .sort((a, b) => rank(a.coil) - rank(b.coil) || a.index - b.index)
    .map((entry) => entry.coil);
}

/**
 * La tolerancia de espesor vigente, en mm (D-086).
 *
 * Vive junto al filtro y no en cada servicio porque la pregunta "qué bobina sirve" tiene que
 * responderse igual en los dos lados: el override de entorno existe (`ROOFING_THICKNESS_TOLERANCE_MM`)
 * y leerlo en un lado y no en el otro reabre la divergencia por el argumento.
 */
export function roofingToleranceMm(env: Pick<Env, 'ROOFING_THICKNESS_TOLERANCE_MM'>): string {
  return env.ROOFING_THICKNESS_TOLERANCE_MM || ROOFING_THICKNESS_TOLERANCE_MM;
}

export function roofingCoilWhere(input: {
  businessLineId: string;
  colorId: string | null;
  /** Espesor de entrada que pide la receta, en mm. */
  inputThicknessMm: Prisma.Decimal | Decimal;
  /** Tolerancia en mm (`ROOFING_THICKNESS_TOLERANCE_MM`). */
  toleranceMm: string;
}): Prisma.CoilWhereInput {
  const tolerance = toDecimal(input.toleranceMm);
  const thickness = toDecimal(input.inputThicknessMm.toString());
  return {
    kind: CoilKind.COIL,
    status: CoilStatus.OPEN,
    businessLineId: input.businessLineId,
    colorId: input.colorId,
    thicknessMm: {
      gte: thickness.minus(tolerance).toFixed(2),
      lte: thickness.plus(tolerance).toFixed(2),
    },
  };
}
