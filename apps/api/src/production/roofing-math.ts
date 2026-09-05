import { BadRequestException } from '@nestjs/common';
import { Decimal, roundTo, theoreticalKgPerPiece, toDecimal, type PieceLike } from '@ayr/shared';

/**
 * Aritmética de la producción de coberturas (D-047, D-089).
 *
 * Separada del servicio por el mismo motivo que `production-math.ts` y `coil-split-math.ts`:
 * es la parte que se puede probar sin base de datos, y es donde vive el único cálculo de la
 * fase que, si se equivoca, no lo nota nadie hasta que el kardex no cuadra.
 */

/** La geometría del rollo montado. Es de donde sale el kilo, no del maestro (D-047). */
export interface CoilGeometry {
  widthMm: string;
  thicknessMm: string;
  /** `densityFactor` del acabado de la bobina (RF-25). */
  densityFactor: string;
}

/**
 * Kilos teóricos de una lista de largos rolados en esa bobina.
 *
 * `ancho × espesor × largo × densidad`, exactamente D-047 para coberturas, con el ancho y el
 * espesor **de la bobina** y no de la receta: lo que la roladora se come por metro es el
 * ancho completo del fleje que entra, así que el recorte lateral ya queda dentro de esta
 * cuenta en vez de aparecer después como una merma sin explicación.
 */
export function roofingTheoreticalKg(
  geometry: CoilGeometry,
  pieces: readonly PieceLike[],
): Decimal {
  const total = pieces.reduce((acc, piece) => {
    const perPiece = theoreticalKgPerPiece({
      widthMm: geometry.widthMm,
      thicknessMm: geometry.thicknessMm,
      pieceLengthMm: piece.lengthMm,
      densityFactor: geometry.densityFactor,
    });
    return acc.plus(perPiece.times(piece.qty));
  }, new Decimal(0));
  return roundTo(total, 'KG');
}

/**
 * El plan de corte de una OP de coberturas: los largos que el pedido encargó, o —si la
 * línea es una plancha de catálogo sin subítems— un solo largo derivado de la receta y la
 * cantidad pedida (D-084). La usan tanto `create()` al nacer la OP como la cola de Fase 7
 * (D-093) para mostrar los mismos subítems antes de que la OP exista.
 */
export function derivePiecesPlan(
  pieces: readonly PieceLike[],
  bomPieceLengthMm: string | null,
  qty: string,
): (PieceLike & { lineNumber: number })[] {
  if (pieces.length > 0) {
    return pieces.map((p, i) => ({ lineNumber: i + 1, lengthMm: p.lengthMm, qty: p.qty }));
  }
  if (bomPieceLengthMm === null) return [];
  return [
    {
      lineNumber: 1,
      lengthMm: bomPieceLengthMm,
      // Hacia arriba y con Decimal (D-003): con `Number(qty.toFixed(0))` el redondeo ya
      // había ocurrido y 2.4 planchas quedaban en 2.
      qty: toDecimal(qty).ceil().toNumber(),
    },
  ];
}

/**
 * Metros que salen de un saldo de kilos con esa geometría: lo que planta necesita ver.
 *
 * El kilo por metro se calcula **sin redondear** y recién el resultado se lleva a escala:
 * redondearlo a tres decimales antes de dividir movía la estimación casi un centímetro por
 * metro, que sobre un rollo entero son varios metros de diferencia.
 */
export function metersFromKg(geometry: CoilGeometry, availableKg: string): Decimal {
  const kgPerMeter = toDecimal(geometry.widthMm)
    .times(toDecimal(geometry.thicknessMm))
    .times(1000)
    .times(toDecimal(geometry.densityFactor))
    .div(1_000_000);
  if (kgPerMeter.lte(0)) return new Decimal(0);
  return roundTo(toDecimal(availableKg).div(kgPerMeter), 'KG');
}

export interface RoofingCloseInput {
  /** Kilos que planta declara que la bobina consumió de verdad (D-089). */
  declaredKg: Decimal;
  /** Kilos teóricos ya emitidos por los reportes vigentes. */
  reportedKg: Decimal;
  /** Kilos todavía asignados a la orden y no consumidos. */
  remainingKg: Decimal;
}

export interface RoofingCloseResult {
  /** Merma por despunte: lo declarado por encima de lo teórico. */
  scrapKg: Decimal;
  /** Fracción de merma sobre lo consumido; por encima del umbral, cerrar exige motivo. */
  scrapRatio: Decimal;
}

/**
 * La merma de despunte del cierre (D-089).
 *
 * **No es el patrón de D-057 tal cual**, y esa es la decisión: en drywall todo lo asignado
 * que no llegó a ser pieza es merma, porque el fleje entra entero a la perfiladora. Una
 * bobina de coberturas se queda montada en la roladora y su sobrante sigue siendo
 * inventario, así que la merma es solo la diferencia entre lo que planta declara que se
 * consumió y lo que los largos reportados representan.
 *
 * El ratio se mide **sobre lo consumido** y no sobre lo asignado: asignar el rollo entero es
 * lo normal, y medir contra eso daría un porcentaje ridículo que exigiría motivo siempre.
 */
export function roofingCloseScrap(input: RoofingCloseInput): RoofingCloseResult {
  const scrapKg = Decimal.max(input.declaredKg.minus(input.reportedKg), new Decimal(0));
  const scrapRatio = input.declaredKg.lte(0) ? new Decimal(0) : scrapKg.div(input.declaredKg);
  return { scrapKg: roundTo(scrapKg, 'KG'), scrapRatio };
}

export interface RoofingCostInput {
  /** Valor en soles que los reportes vigentes sacaron de las bobinas. */
  reportsCostPen: Decimal;
  /** Valor en soles de la merma por despunte del cierre (D-089). */
  scrapCostPen: Decimal;
  /** Producto bueno de la corrida: metros lineales a medida, o planchas de catálogo. */
  outputQty: Decimal;
}

export interface RoofingCost {
  materialCostPen: Decimal;
  /** Hook de D-035: en v1 siempre cero (rolado con máquina propia, D-090). */
  overheadCostPen: Decimal;
  totalCostPen: Decimal;
  unitCostPen: Decimal;
}

/**
 * Costo de la corrida de coberturas (D-056 sin variantes, D-090): todo el material que
 * salió de la bobina —el que quedó en producto y el que se fue en despunte— repartido entre
 * el producto bueno. La merma no destruye valor, la absorbe el producto.
 *
 * Es la misma cuenta que `productionCost`, con una diferencia que no se puede compartir: el
 * divisor de drywall son piezas enteras y el de una cobertura a medida son **metros**, que
 * es un `Decimal`. Forzar un entero acá redondearía el costo unitario de cada corrida.
 */
export function roofingCost(input: RoofingCostInput): RoofingCost {
  if (input.outputQty.lte(0)) {
    throw new BadRequestException('Una orden sin producto bueno no se puede costear');
  }
  const materialCostPen = roundTo(input.reportsCostPen.plus(input.scrapCostPen), 'MONEY');
  const overheadCostPen = new Decimal(0);
  const totalCostPen = roundTo(materialCostPen.plus(overheadCostPen), 'MONEY');
  return {
    materialCostPen,
    overheadCostPen,
    totalCostPen,
    unitCostPen: roundTo(totalCostPen.div(input.outputQty), 'MONEY'),
  };
}

/**
 * Ajuste que el cierre emite sobre el producto terminado: la diferencia entre lo que la
 * corrida costó de verdad y el valor con el que el producto fue entrando reporte a reporte.
 * Se lleva el costo del despunte y el residuo de redondeo de cada reporte, y por eso el
 * kardex cierra exacto. Puede ser negativo.
 */
export function roofingCloseAdjustmentPen(
  totalCostPen: Decimal,
  reports: { qty: Decimal; unitCostPen: string }[],
): Decimal {
  const enteredValuePen = reports.reduce(
    (acc, r) => acc.plus(toDecimal(r.unitCostPen).times(r.qty)),
    new Decimal(0),
  );
  return roundTo(totalCostPen.minus(enteredValuePen), 'MONEY');
}
