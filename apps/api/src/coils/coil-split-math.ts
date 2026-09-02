import { BadRequestException } from '@nestjs/common';
import { Decimal, roundTo, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Aritmética del partido de bobina (RF-15), aparte del servicio para poder probarla
 * sola, igual que `purchase-math.ts`. Nada de esto toca la base ni el kardex.
 *
 * Modelo (D-041, ver `coil_splits` en el schema): se parte una porción del **largo**
 * del rollo, así que la madre conserva su ancho y pierde peso. El peso que entra al
 * partido se reparte **por ancho** entre las hijas y la merma de corte, sobre
 * `Σ anchos de hijas + kerfLossMm`.
 */

export interface SplitChildPlan {
  widthMm: Decimal;
  weightKg: Decimal;
}

export interface SplitPlan {
  splitWeightKg: Decimal;
  kerfLossMm: Decimal;
  kerfLossKg: Decimal;
  consumedWidthMm: Decimal;
  children: SplitChildPlan[];
}

export interface SplitPlanInput {
  parentWidthMm: DecimalInput;
  /** Kilos disponibles de la madre según el kardex, no su `weightKg` de alta. */
  availableKg: DecimalInput;
  /** Si no viene, se parte todo el saldo disponible. */
  splitWeightKg?: DecimalInput;
  kerfLossMm: DecimalInput;
  /** Anchos de las hijas, ya expandidos (una entrada por bobina hija). */
  widthsMm: DecimalInput[];
}

/**
 * Calcula la salida de la madre y el peso de cada hija, o lanza con el motivo exacto
 * si el plan no cierra. El reparto se hace por **acumulado redondeado** (el peso de la
 * hija `i` es el acumulado hasta `i` menos el acumulado hasta `i-1`), así la suma de
 * las hijas más la merma da exactamente `splitWeightKg` y no aparece un residuo de
 * milésimas que el kardex tendría que absorber en algún lado.
 */
export function planCoilSplit(input: SplitPlanInput): SplitPlan {
  const parentWidth = toDecimal(input.parentWidthMm);
  const available = toDecimal(input.availableKg);
  const kerfMm = toDecimal(input.kerfLossMm);
  const widths = input.widthsMm.map((w) => toDecimal(w));

  if (widths.length === 0) {
    throw new BadRequestException('El partido necesita al menos una bobina hija');
  }
  if (widths.some((w) => w.lte(0))) {
    throw new BadRequestException('El ancho de cada hija debe ser mayor a cero');
  }
  if (kerfMm.isNegative()) {
    throw new BadRequestException('La merma de corte no puede ser negativa');
  }
  if (available.lte(0)) {
    throw new BadRequestException('La bobina no tiene kilos disponibles para partir');
  }

  const splitWeight = roundTo(input.splitWeightKg ?? available, 'KG');
  if (splitWeight.lte(0)) {
    throw new BadRequestException('El peso a partir debe ser mayor a cero');
  }
  if (splitWeight.gt(available)) {
    throw new BadRequestException(
      `El peso a partir (${splitWeight.toFixed(3)} kg) supera el disponible de la bobina (${available.toFixed(3)} kg)`,
    );
  }

  const widthsTotal = widths.reduce((acc, w) => acc.plus(w), new Decimal(0));
  const consumedWidth = widthsTotal.plus(kerfMm);
  if (consumedWidth.gt(parentWidth)) {
    throw new BadRequestException(
      `Los anchos de las hijas más la merma de corte (${consumedWidth.toFixed(2)} mm) superan el ancho de la madre (${parentWidth.toFixed(2)} mm)`,
    );
  }

  const children: SplitChildPlan[] = [];
  let cumulativeWidth = new Decimal(0);
  let previousWeight = new Decimal(0);
  for (const width of widths) {
    cumulativeWidth = cumulativeWidth.plus(width);
    const cumulativeWeight = roundTo(splitWeight.times(cumulativeWidth).div(consumedWidth), 'KG');
    const weightKg = cumulativeWeight.minus(previousWeight);
    if (weightKg.lte(0)) {
      throw new BadRequestException(
        `El ancho ${width.toFixed(2)} mm no alcanza para un kilo redondeable: sube el peso a partir o quita esa hija`,
      );
    }
    children.push({ widthMm: width, weightKg });
    previousWeight = cumulativeWeight;
  }

  // La merma se lleva lo que no quedó en ninguna hija; el redondeo acumulado garantiza
  // que nunca sea negativa cuando `kerfLossMm` es cero (ahí `consumedWidth` = Σ anchos).
  const kerfLossKg = splitWeight.minus(previousWeight);
  if (kerfLossKg.isNegative()) {
    throw new BadRequestException('El reparto de peso no cierra: revisa los anchos y la merma');
  }

  return {
    splitWeightKg: splitWeight,
    kerfLossMm: roundTo(kerfMm, 'MM'),
    kerfLossKg,
    consumedWidthMm: roundTo(consumedWidth, 'MM'),
    children,
  };
}

/** Expande `{ widthMm, count }` a una entrada por bobina hija, en orden. */
export function expandSplitWidths(rows: { widthMm: string; count: number }[]): string[] {
  return rows.flatMap((row) => Array.from({ length: row.count }, () => row.widthMm));
}
