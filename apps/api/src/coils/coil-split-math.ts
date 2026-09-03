import { BadRequestException } from '@nestjs/common';
import { Decimal, roundTo, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Aritmética del partido de bobina (RF-15), aparte del servicio para poder probarla
 * sola, igual que `purchase-math.ts`. Nada de esto toca la base ni el kardex.
 *
 * Modelo (D-041, ver `coil_splits` en el schema): se parte una porción del **largo**
 * del rollo, así que la madre conserva su ancho y pierde peso. El peso que entra al
 * partido se reparte **por ancho sobre el ancho de la madre**: una hija de 600 mm de
 * una bobina de 1220 mm se lleva 600/1220 de los kilos partidos, no 600/(Σ anchos).
 *
 * Prorratear sobre `Σ anchos + kerf` sería lo intuitivo pero está mal: si las tiras no
 * consumen todo el ancho, la última se llevaría kilos que físicamente no puede tener
 * para su ancho y su espesor, y el recorte de borde desaparecería del kardex sin
 * haberse dado de baja nunca. Todo lo que no queda en una hija —el kerf declarado más
 * el recorte de borde— va a `kerfLossKg`, que es la pérdida real del corte.
 */

/**
 * Ancho mínimo de una bobina hija, en mm. Una tira más angosta que esto no existe en
 * una slitter real; el límite está para que nadie pueda "partir" una bobina en una
 * tira de 0.01 mm y hacer desaparecer el resto del valor como merma de corte.
 */
export const MIN_CHILD_WIDTH_MM = 5;

/**
 * Fracción mínima del ancho de la madre que tienen que cubrir las hijas. Un corte que
 * bota más del 20 % del ancho no es un partido, es dar de baja la bobina: para eso está
 * la merma (RF-17), que exige motivo y queda auditada como tal.
 */
export const MIN_SPLIT_YIELD = 0.8;

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
  if (widths.some((w) => w.lt(MIN_CHILD_WIDTH_MM))) {
    throw new BadRequestException(
      `El ancho de cada hija debe ser de al menos ${MIN_CHILD_WIDTH_MM} mm`,
    );
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
  // Piso de rendimiento: como el peso se reparte sobre el ancho de la madre, todo el
  // ancho que las hijas no cubren se va a `kerfLossKg`. Sin este límite, un partido con
  // una sola tira angosta sería una forma de destruir el valor de la bobina sin dejar
  // el rastro que sí deja una merma (RF-17).
  const minWidth = parentWidth.times(MIN_SPLIT_YIELD);
  if (widthsTotal.lt(minWidth)) {
    throw new BadRequestException(
      `Las hijas cubren ${widthsTotal.toFixed(2)} mm de los ${parentWidth.toFixed(2)} mm de la madre: un partido tiene que aprovechar al menos ${minWidth.toFixed(2)} mm. Si vas a dar de baja el resto, regístralo como merma.`,
    );
  }

  const children: SplitChildPlan[] = [];
  let cumulativeWidth = new Decimal(0);
  let previousWeight = new Decimal(0);
  for (const width of widths) {
    cumulativeWidth = cumulativeWidth.plus(width);
    const cumulativeWeight = roundTo(splitWeight.times(cumulativeWidth).div(parentWidth), 'KG');
    const weightKg = cumulativeWeight.minus(previousWeight);
    if (weightKg.lte(0)) {
      throw new BadRequestException(
        `El ancho ${width.toFixed(2)} mm no alcanza para un kilo redondeable: sube el peso a partir o quita esa hija`,
      );
    }
    children.push({ widthMm: width, weightKg });
    previousWeight = cumulativeWeight;
  }

  // Todo lo que no quedó en una hija es pérdida de corte: el kerf declarado más el
  // recorte de borde que sobra cuando las tiras no cubren el ancho entero. Como el
  // reparto usa el ancho de la madre, esto nunca puede ser negativo.
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
