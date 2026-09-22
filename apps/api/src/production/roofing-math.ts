import { BadRequestException } from '@nestjs/common';
import { RoofingProductKind, type Prisma } from '@prisma/client';
import {
  accessoryEdgeScrap,
  accessoryEffectiveWidthMm,
  accessoryPiecesPerPass,
  Decimal,
  equivalentMeters,
  piecesTheoreticalKg,
  roundTo,
  toDecimal,
  type PieceLike,
} from '@ayr/shared';

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
  // D-146: el cuerpo vive en `@ayr/shared` porque la pantalla de planta muestra este mismo
  // número —el kilo teórico del plan— antes de que nadie tipee. Esto quedó como el nombre
  // que el módulo de coberturas ya usaba, no como una segunda cuenta: dos copias serían dos
  // topes distintos, que es exactamente lo que el tope de kg declarado no puede permitirse.
  return piecesTheoreticalKg(geometry, pieces);
}

// ---------------------------------------------------------------------------
// D-242 — la pasada de un accesorio
// ---------------------------------------------------------------------------

/** Lo que hace falta del producto para saber si una OP rola un accesorio y con qué medida. */
export interface AccessoryProductLike {
  sku: string;
  roofingKind: RoofingProductKind | null;
  developmentMm: Prisma.Decimal | null;
  /** Ancho **nominal** del SKU: con el que se cotizó, no con el que se produce. */
  widthMm: Prisma.Decimal | null;
}

/**
 * Todo lo que un accesorio cambia respecto de una cobertura a medida, resuelto **una vez**
 * contra el rollo que de verdad está montado (D-242).
 */
export interface AccessoryConversion {
  piecesPerPass: number;
  /** `ancho del rollo ÷ N`: el ancho con el que se cuenta el material (D-b). */
  effectiveWidthMm: string;
  /** Piezas por pasada que daría el ancho **nominal** del SKU. `null` si no se puede saber. */
  nominalPiecesPerPass: number | null;
  /** Canto de cada pasada y su fracción del ancho, para mostrarlos (D-d). */
  edgeMm: string;
  edgeRatio: Decimal;
}

/**
 * Resuelve la conversión de un accesorio contra la bobina montada.
 *
 * **Manda el ancho real del rollo, no el nominal** (ajuste 1 del dueño): un desarrollo de
 * 305 mm rinde 3 piezas en un rollo de 1 200 mm y 4 en uno de 1 220, así que producir con el
 * número de la cotización sería reportar metros que no salieron. Que los dos difieran no es
 * un error —es el rollo que había— pero tiene que **verse**, y por eso la conversión devuelve
 * también el nominal en vez de descartarlo.
 *
 * `null` cuando la OP no es de accesorios: quien llama sigue derecho por el camino de D-083.
 */
export function accessoryConversion(
  product: AccessoryProductLike,
  coilWidthMm: string,
): AccessoryConversion | null {
  if (product.roofingKind !== RoofingProductKind.ACCESORIO) return null;
  if (product.developmentMm === null) {
    throw new BadRequestException(
      `${product.sku} es un accesorio sin desarrollo en el catálogo: sin él no se sabe cuántas piezas da una pasada`,
    );
  }
  const developmentMm = product.developmentMm.toFixed(2);
  const scrap = accessoryEdgeScrap(coilWidthMm, developmentMm);
  const effective = accessoryEffectiveWidthMm(coilWidthMm, developmentMm);
  if (scrap === null || effective === null) {
    throw new BadRequestException(
      `El desarrollo de ${product.sku} (${toDecimal(developmentMm).div(1000).toFixed(3)} m) no entra ` +
        `en el ancho de la bobina montada (${toDecimal(coilWidthMm).div(1000).toFixed(3)} m): ` +
        'esa bobina no da ni una pieza por pasada',
    );
  }
  return {
    piecesPerPass: scrap.piecesPerPass,
    effectiveWidthMm: effective.toString(),
    nominalPiecesPerPass:
      product.widthMm === null
        ? null
        : accessoryPiecesPerPass(product.widthMm.toFixed(2), developmentMm),
    edgeMm: scrap.edgeMm.toFixed(2),
    edgeRatio: scrap.edgeRatio,
  };
}

/**
 * Las pasadas que planta reportó, convertidas en las piezas que entran al kardex (D-c).
 *
 * Se persisten **piezas** y no pasadas a propósito: así el kardex, el costo, la reversa y el
 * progreso del plan siguen leyendo lo mismo que en una cobertura a medida, sin una segunda
 * rama que pueda divergir. Una pasada de 3 m que da 4 piezas se guarda como 4 piezas de 3 m,
 * que es lo que de verdad salió de la roladora.
 */
export function accessoryPiecesFromPasses<T extends { qty: number }>(
  passes: readonly T[],
  piecesPerPass: number,
): T[] {
  return passes.map((pass) => ({ ...pass, qty: pass.qty * piecesPerPass }));
}

/**
 * El aviso de rendimiento (ajuste 1): lo que planta tiene que ver cuando el rollo montado no
 * rinde lo que rendía el ancho con el que se cotizó. `null` cuando coinciden o no hay con qué
 * comparar.
 */
export function accessoryYieldWarning(
  sku: string,
  conversion: AccessoryConversion,
  coilCode: string,
): string | null {
  const nominal = conversion.nominalPiecesPerPass;
  if (nominal === null || nominal === conversion.piecesPerPass) return null;
  return (
    `${sku}: la bobina ${coilCode} da ${conversion.piecesPerPass} ` +
    `${conversion.piecesPerPass === 1 ? 'pieza' : 'piezas'} por pasada, y con el ancho del ` +
    `catálogo daban ${nominal}. Los metros de esta corrida salen del rollo montado, así que ` +
    `rinde ${conversion.piecesPerPass > nominal ? 'más' : 'menos'} de lo cotizado: revisá el ` +
    'plan de corte antes de cerrar.'
  );
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
  return equivalentMeters(geometry, availableKg) ?? new Decimal(0);
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
