import { z } from 'zod';
import {
  decimalStringSchema,
  MAX_VALUE,
  roundTo,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '../decimal';
import {
  BUSINESS_LINES,
  PRODUCT_BOM_KINDS,
  ProductBomKind,
  PRODUCTION_ORDER_KINDS,
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_REPORT_STATUSES,
} from '../enums';
import { reasonSchema } from './coil';
import { backdatableFields } from './operation';
import { roofingPieceSchema } from './roofing';

/**
 * Producción de drywall (RF-32..35, RF-39; D-055..D-060).
 *
 * Modelo en una línea: una OP toma flejes (`coils kind=STRIP`) contra la receta del
 * producto (D-059), reporta piezas en N eventos (D-058) y se cierra. La unidad primaria
 * del producto terminado son **piezas** (D-055); los kilos son derivados
 * (`piezas × kgPerPiece`). Asignar un fleje no mueve kardex (D-060, mismo criterio que
 * D-050): el kardex sale con cada reporte y, al cerrar, con la merma de proceso (D-057).
 */

// --------------------------------------------------------------------------
// Constantes y aritmética compartida entre web y API
// --------------------------------------------------------------------------

/**
 * Tope de flejes asignados a una misma OP. Cada uno abre una fila y, en cada reporte,
 * puede abrir un movimiento de kardex dentro de la transacción que sostiene sus locks —
 * mismo motivo que `MAX_SPLIT_CHILDREN` en el partido (RF-15).
 */
export const MAX_ORDER_STRIPS = 20;

/** Tope de piezas de un solo reporte. Una corrida real de drywall no pasa de miles. */
export const MAX_REPORT_PIECES = 1_000_000;

/**
 * Tope de reportes vigentes por orden. Una corrida real reporta por tanda, no por pieza;
 * sin cota, `POST /:id/report` de una pieza a la vez haría crecer el detalle de la OP sin
 * límite y la lista de planta tendría que materializarlo entero en cada recarga.
 */
export const MAX_ORDER_REPORTS = 200;

/**
 * Fracción de merma de proceso que una orden puede cerrar **sin motivo escrito**. Por
 * encima, cerrar exige un `reason` como cualquier otra merma (RF-17/D-040): un cierre con
 * un cuarto del material sin convertir en piezas es una baja de inventario, y una baja de
 * inventario sin motivo no queda auditable (RF-95).
 */
export const MAX_SCRAP_RATIO_WITHOUT_REASON = 0.1;

/**
 * Banda dentro de la cual el kilo declarado por planta no dice nada (D-154).
 *
 * Un reporte de coberturas declara los kilos que la bobina se comió y el sistema conoce los
 * teóricos de esos largos (D-047). Nunca coinciden: el despunte, el ancho real del rollo y la
 * balanza de planta los separan siempre un poco. Fuera de ±10 % ya no es ruido — por arriba
 * es una corrida que gastó de más, por abajo casi siempre es un dígito de menos al tipear.
 * En **ningún** caso bloquea (D-154): es un dato observado, y un dato que hay que falsear
 * para poder guardarlo deja de ser un dato.
 */
export const MAX_CONSUMPTION_DEVIATION_RATIO = 0.1;

/**
 * D-165 — **la merma normal, en puntos porcentuales**, absorbida dentro del estándar.
 *
 * Regla del cliente confirmada por el dueño: convertir geometría en kilos rinde siempre un
 * 1 % menos de material del que el prisma perfecto promete. Recorte lateral, despunte de
 * arranque y el propio espesor real del rollo son pérdidas que ocurren **todas las veces**,
 * así que no son un hecho a registrar: son parte del costo de hacer un metro.
 */
export const NORMAL_SCRAP_RATE_PCT = '1.0000';

/**
 * D-165 — la densidad del acabado **con la merma normal adentro**: `densidad × 1.01`.
 *
 * Vive en una función y no como un `× 1.01` repetido en las dos cuentas de abajo, y sobre
 * todo **no** como un valor tipeado a mano en `finishes.density_factor`, por tres motivos:
 *
 * 1. La densidad del acero es un dato físico (7.85 t/m³) y la merma es una política de la
 *    empresa. Multiplicarlos en el maestro deja un número que no es ninguna de las dos cosas
 *    y que nadie puede volver a separar: revisar el 1 % obligaría a dividir cada acabado por
 *    1.01 primero, adivinando cuáles ya lo tenían.
 * 2. El factor entra por **un solo lugar**, así que el kilo teórico del reporte, el metro
 *    equivalente de la bobina, los kilos que reserva una cobertura a medida y el costo por
 *    metro del piso de precio (D-163) se mueven todos juntos. Aplicado a mano en los datos,
 *    se movían solo los acabados que alguien se acordó de editar.
 * 3. Es lo que hace medible la merma **anormal**: con el 1 % adentro del estándar, el
 *    remanente que D-164 liquida al cerrar la bobina ya no mezcla las dos.
 */
export function standardDensityFactor(densityFactor: DecimalInput): Decimal {
  return toDecimal(densityFactor).times(
    toDecimal('1').plus(toDecimal(NORMAL_SCRAP_RATE_PCT).div(100)),
  );
}

/**
 * Kilo teórico de una pieza desde su geometría y el factor de densidad del acabado
 * (D-047, RF-25). `widthMm × thicknessMm × lengthMm` da mm³; el factor viene en t/m³
 * (acero ≈ 7.85), así que dividir entre 1 000 000 deja kilos:
 * `mm³ / 1e9 = m³`, `× (factor × 1000) = kg` ⇒ `mm³ × factor / 1e6`.
 *
 * D-165: la densidad que entra en la cuenta es la **estándar**, con el 1 % de merma normal
 * adentro. El número que sale es lo que la bobina entrega de menos, no lo que la pieza pesa.
 *
 * Vive acá y no en el API para que el maestro (web) sugiera exactamente el mismo número
 * que el API valida, igual que las constantes del partido (RF-15).
 */
export function theoreticalKgPerPiece(input: {
  widthMm: DecimalInput;
  thicknessMm: DecimalInput;
  pieceLengthMm: DecimalInput;
  densityFactor: DecimalInput;
}): Decimal {
  const volume = toDecimal(input.widthMm)
    .times(toDecimal(input.thicknessMm))
    .times(toDecimal(input.pieceLengthMm));
  return roundTo(volume.times(standardDensityFactor(input.densityFactor)).div(1_000_000), 'KG');
}

/** `piezas × kgPerPiece`, redondeado a la escala de kilos (D-003). */
export function theoreticalKg(pieces: number, kgPerPiece: DecimalInput): Decimal {
  return roundTo(toDecimal(kgPerPiece).times(pieces), 'KG');
}

/** Geometría de la que sale el kilo teórico: el rollo montado, no el maestro (D-047). */
export interface PieceGeometry {
  widthMm: DecimalInput;
  thicknessMm: DecimalInput;
  /** `densityFactor` del acabado (RF-25). */
  densityFactor: DecimalInput;
}

/**
 * Kilos teóricos de una lista de largos rolados con esa geometría (D-047).
 *
 * Vive acá —y no en `apps/api/.../roofing-math.ts`, que ahora la envuelve— porque desde
 * D-146 el número lo necesitan los dos lados: el API para topar el kg declarado de un
 * reporte contra el kilo teórico del plan, y la pantalla de planta para **mostrar** ese
 * mismo tope antes de que nadie tipee. Dos copias de esta cuenta serían dos topes distintos.
 */
export function piecesTheoreticalKg(
  geometry: PieceGeometry,
  pieces: readonly { lengthMm: DecimalInput; qty: number }[],
): Decimal {
  const total = pieces.reduce((acc, piece) => {
    const perPiece = theoreticalKgPerPiece({
      widthMm: geometry.widthMm,
      thicknessMm: geometry.thicknessMm,
      pieceLengthMm: piece.lengthMm,
      densityFactor: geometry.densityFactor,
    });
    return acc.plus(perPiece.times(piece.qty));
  }, toDecimal('0'));
  return roundTo(total, 'KG');
}

/**
 * Kilo teórico de un metro lineal de esa geometría (RF-25), **sin redondear**: es un
 * resultado intermedio de `equivalentMeters`, y redondearlo acá (como sí hace
 * `theoreticalKgPerPiece`, que es un resultado final) movería la estimación casi un
 * centímetro por metro antes de dividir.
 *
 * D-165: con la densidad **estándar**, igual que `theoreticalKgPerPiece`. Es la misma
 * pregunta —cuánto material se lleva esto— y tiene que dar el mismo factor: si una de las
 * dos llevara la merma normal y la otra no, los kilos que un pedido reserva por metro y los
 * que el reporte de planta descuenta por metro serían distintos.
 */
export function kgPerMeter(input: {
  widthMm: DecimalInput;
  thicknessMm: DecimalInput;
  densityFactor: DecimalInput;
}): Decimal {
  return toDecimal(input.widthMm)
    .times(toDecimal(input.thicknessMm))
    .times(1000)
    .times(standardDensityFactor(input.densityFactor))
    .div(1_000_000);
}

/**
 * Metro lineal equivalente de un saldo de kilos con esa geometría (Fase 7e, D-116):
 * `saldo_kg / (ancho_m × espesor_mm × densidad)`, la misma cuenta que `kgPerMeter`
 * invertida. `null` cuando la geometría no da kilo por metro (ancho o espesor en cero).
 */
export function equivalentMeters(
  geometry: { widthMm: DecimalInput; thicknessMm: DecimalInput; densityFactor: DecimalInput },
  availableKg: DecimalInput,
): Decimal | null {
  const perMeter = kgPerMeter(geometry);
  if (perMeter.lte(0)) return null;
  return roundTo(toDecimal(availableKg).div(perMeter), 'KG');
}

// --------------------------------------------------------------------------
// D-059 — receta en el maestro de productos
// --------------------------------------------------------------------------

const piecesSchema = z
  .number({ required_error: 'Las piezas son obligatorias' })
  .int('Las piezas se cuentan en enteros')
  .min(1, 'Al menos una pieza')
  .max(MAX_REPORT_PIECES, `Máximo ${MAX_REPORT_PIECES} piezas`);

export const upsertProductBomSchema = z
  .object({
    /**
     * D-087. `DRYWALL` consume un fleje de ancho exacto y produce piezas de largo fijo;
     * `ROOFING` consume una bobina filtrada por espesor y color (D-086) y produce planchas
     * cuyo largo lo pone el pedido (a medida) o el propio SKU (plancha de catálogo).
     */
    kind: z.enum(PRODUCT_BOM_KINDS).default(ProductBomKind.DRYWALL),
    finishId: z.string({ required_error: 'El acabado del material es obligatorio' }).uuid(),
    inputThicknessMm: decimalStringSchema('MM', {
      positive: true,
      max: MAX_VALUE.THICKNESS_MM,
    }),
    /** Ancho exacto del fleje. **Solo DRYWALL**: ver el comentario del schema de Prisma. */
    inputWidthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((bom, ctx) => {
    // D-122: la receta es **solo** de drywall. Una cobertura no lleva ninguna: su acabado,
    // su geometría y su color viven en el SKU.
    if (bom.kind !== ProductBomKind.DRYWALL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message:
          'Una cobertura no lleva receta desde D-122: su acabado, su geometría y su color son del propio producto',
      });
      return;
    }
    if (bom.inputWidthMm === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputWidthMm'],
        message: 'El ancho del fleje es obligatorio en una receta de drywall',
      });
    }
  });
export type UpsertProductBomInput = z.infer<typeof upsertProductBomSchema>;

export const productBomSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  productUnit: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  kind: z.enum(PRODUCT_BOM_KINDS),
  finishId: z.string().uuid(),
  finishCode: z.string(),
  finishName: z.string(),
  /** Factor de densidad del acabado (RF-25): lo que convierte geometría en kilos (D-047). */
  densityFactor: z.string(),
  inputThicknessMm: z.string(),
  inputWidthMm: z.string().nullable(),
  /**
   * D-122/D-139: los dos salen del **SKU**, no de la receta. Se siguen exponiendo acá
   * porque la pantalla de la receta es donde se miran, pero se editan en el catálogo y
   * tienen una sola fuente.
   */
  pieceLengthMm: z.string().nullable(),
  kgPerPiece: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductBomDto = z.infer<typeof productBomSchema>;

// --------------------------------------------------------------------------
// RF-34 — orden de producción
// --------------------------------------------------------------------------

export const createProductionOrderSchema = z.object({
  ...backdatableFields,
  productId: z.string({ required_error: 'El producto a fabricar es obligatorio' }).uuid(),
  targetPieces: piecesSchema.optional(),
  notes: z.string().trim().max(500).optional(),
  /**
   * D-054/D-066: reserva de un pedido que esta OP viene a cumplir. Con ella, la orden puede
   * montar el material reservado (que para cualquier otra orden está bloqueado) y, al
   * emitir el primer material, la reserva pasa a `CONSUMIDA`. Sin ella, la OP es una
   * corrida de stock como las de Fase 4.
   */
  reservationId: z.string().uuid().optional(),
});
export type CreateProductionOrderInput = z.infer<typeof createProductionOrderSchema>;

/**
 * Asignar un fleje a la OP. `qtyKg` opcional: sin él se toma todo el saldo disponible
 * del fleje, que es el caso normal en planta (el operario monta el rollo entero).
 */
export const consumeStripSchema = z.object({
  coilId: z.string({ required_error: 'El fleje es obligatorio' }).uuid(),
  qtyKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
});
export type ConsumeStripInput = z.infer<typeof consumeStripSchema>;

/** Reporte parcial de piezas buenas (D-058). */
export const reportPiecesSchema = z.object({
  ...backdatableFields,
  pieces: piecesSchema,
  notes: z.string().trim().max(240).optional(),
});
export type ReportPiecesInput = z.infer<typeof reportPiecesSchema>;

/**
 * Cerrar la OP: la merma de proceso sale sola por diferencia (D-057), sin input. El
 * `reason` solo es obligatorio cuando esa merma supera `MAX_SCRAP_RATIO_WITHOUT_REASON`
 * del material asignado — el API es quien decide, porque solo él conoce los kilos reales.
 */
export const closeProductionOrderSchema = z.object({
  ...backdatableFields,
  notes: z.string().trim().max(240).optional(),
  reason: reasonSchema.optional(),
});
export type CloseProductionOrderInput = z.infer<typeof closeProductionOrderSchema>;

/** Anular la OP y liberar los flejes no consumidos. Motivo obligatorio (RF-95). */
export const cancelProductionOrderSchema = z.object({
  ...backdatableFields,
  reason: reasonSchema,
});
export type CancelProductionOrderInput = z.infer<typeof cancelProductionOrderSchema>;

/**
 * El aviso de desviación del kilo declarado, o `null` si no hay nada que decir (D-154).
 *
 * Vive acá y no en el servicio por el mismo motivo que `piecesTheoreticalKg`: la pantalla lo
 * muestra **mientras se tipea** y el API lo guarda con el reporte. Dos redacciones del mismo
 * aviso serían dos umbrales distintos en cuanto alguien tocara uno.
 */
export function roofingConsumptionDeviation(input: {
  /** Kilos que planta declara para **este** reporte. */
  declaredKg: DecimalInput;
  /** Kilos teóricos de los largos de **este** reporte, con la geometría del rollo montado. */
  theoreticalKg: DecimalInput;
  /** Kilos ya declarados por los reportes vigentes anteriores. */
  alreadyDeclaredKg: DecimalInput;
  /** Kilos teóricos del plan de corte completo, o `null` si la orden no tiene plan. */
  planKg: DecimalInput | null;
}): string | null {
  const declared = toDecimal(input.declaredKg);
  const theoretical = toDecimal(input.theoreticalKg);
  const notes: string[] = [];

  if (theoretical.gt(0)) {
    const ratio = declared.div(theoretical).minus(1);
    const pct = ratio.abs().times(100).toFixed(1);
    if (ratio.gt(MAX_CONSUMPTION_DEVIATION_RATIO)) {
      notes.push(
        `Consumo declarado ${declared.toFixed(3)} kg contra ${theoretical.toFixed(3)} kg teóricos ` +
          `de los largos reportados: ${pct} % por encima.`,
      );
    } else if (ratio.lt(-MAX_CONSUMPTION_DEVIATION_RATIO)) {
      notes.push(
        `Consumo declarado ${declared.toFixed(3)} kg contra ${theoretical.toFixed(3)} kg teóricos ` +
          `de los largos reportados: ${pct} % por debajo. Revisa que no falte un dígito.`,
      );
    }
  }

  if (input.planKg !== null) {
    const planKg = toDecimal(input.planKg);
    const accumulated = toDecimal(input.alreadyDeclaredKg).plus(declared);
    if (accumulated.gt(planKg)) {
      notes.push(
        `El acumulado declarado (${accumulated.toFixed(3)} kg) pasa los ${planKg.toFixed(3)} kg ` +
          'teóricos del plan de corte con la bobina montada.',
      );
    }
  }

  return notes.length === 0 ? null : notes.join(' ');
}

// --------------------------------------------------------------------------
// D-154 — el aviso del agregado de materia prima
// --------------------------------------------------------------------------

/**
 * Un agregado de materia prima (D-134) que quedó por debajo de lo prometido a **otros**
 * pedidos después de una operación de producción.
 *
 * Es un **aviso, no un rechazo** (D-154): montar una bobina o reportar planchas nunca se
 * bloquea por esto. Quien está en la roladora no puede anular un pedido ajeno ni liberar
 * una reserva, así que cortarle la corrida solo lograba que el material quedara sin
 * registrar; lo que sí puede hacer es avisar a ventas, y para eso necesita saber **qué
 * pedidos** quedan en riesgo y **por cuántos kilos**.
 */
export const rawMaterialWarningSchema = z.object({
  /** `Bobina 0.45 mm ROJO`: el agregado, como lo nombra `rawMaterialLabel`. */
  label: z.string(),
  /** Kilos libres del agregado después de la operación. */
  freeKg: z.string(),
  /** Kilos prometidos a otros pedidos sobre ese mismo agregado. */
  promisedKg: z.string(),
  /** `promisedKg − freeKg`, siempre positivo: lo que falta para cubrir esas promesas. */
  shortfallKg: z.string(),
  /** Los pedidos en riesgo, del más viejo al más nuevo. */
  orders: z.array(z.object({ code: z.string(), qtyKg: z.string() })),
  /** El aviso ya redactado, para mostrarlo sin rearmarlo en cada pantalla. */
  message: z.string(),
});
export type RawMaterialWarningDto = z.infer<typeof rawMaterialWarningSchema>;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

export const productionOrderConsumptionSchema = z.object({
  id: z.string().uuid(),
  coilId: z.string().uuid(),
  coilCode: z.string(),
  widthMm: z.string(),
  /**
   * D-146: el resto de la geometría del rollo montado. Con el ancho alcanzaba mientras el
   * kilo teórico lo calculara solo el API; desde que la pantalla muestra el tope de kilos
   * del plan antes de que nadie tipee, necesita la cuenta completa (`piecesTheoreticalKg`).
   */
  thicknessMm: z.string(),
  densityFactor: z.string(),
  assignedKg: z.string(),
  consumedKg: z.string(),
  /** `assignedKg − consumedKg`: lo que todavía puede convertirse en piezas o en merma. */
  remainingKg: z.string(),
  /** Saldo de kardex del fleje, para que planta vea si le queda material fuera de la OP. */
  coilAvailableKg: z.string(),
  /** Bobina madre del fleje: la trazabilidad hasta el rollo comprado (RF-15/RF-41). */
  parentCoilId: z.string().uuid().nullable(),
  parentCoilCode: z.string().nullable(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ProductionOrderConsumptionDto = z.infer<typeof productionOrderConsumptionSchema>;

export const productionReportSchema = z.object({
  id: z.string().uuid(),
  pieces: z.number().int(),
  /** Solo en coberturas a medida: los metros que entraron al kardex en este reporte (D-083). */
  metersM: z.string().nullable(),
  /** Solo en coberturas: los largos que de verdad salieron. Vacío en drywall. */
  piecesDetail: z.array(roofingPieceSchema),
  theoreticalKg: z.string(),
  /**
   * D-146: kilos que planta declaró para **este** reporte, si los declaró. Es un dato
   * observado, no un consumo: lo que salió del kardex son los `theoreticalKg` (D-047), y el
   * consumo real de la corrida se reconcilia al cerrar (D-089).
   */
  consumedKg: z.string().nullable(),
  /**
   * D-154: el aviso del agregado que este reporte dejó anotado, si lo dejó. Se guarda en la
   * fila y no solo en `audit_log` porque es la mitad que le falta al cierre para explicar
   * por qué el material no alcanzó: quien audita la corrida mira sus reportes, no el log.
   */
  rawMaterialWarning: z.string().nullable(),
  /**
   * Costos en soles (D-042). No van enmascarados por rol como en `/inventory`: el módulo
   * entero está cerrado a ADMINISTRADOR y SUPERVISOR_PLANTA (§3.4), VENDEDOR no llega
   * acá. Si Fase 5 abriera alguna ruta de producción a VENDEDOR, hay que enmascararlos
   * como hace `InventoryService`, no confiar en este comentario.
   */
  materialCostPen: z.string(),
  unitCostPen: z.string(),
  status: z.enum(PRODUCTION_REPORT_STATUSES),
  notes: z.string().nullable(),
  /** D-124: día de negocio del reporte (Lima). Es la fecha por la que el reporte de piezas agrupa. */
  operationDate: z.string(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type ProductionReportDto = z.infer<typeof productionReportSchema>;

export const productionOrderSchema = z.object({
  id: z.string().uuid(),
  /** `OP-000123`, derivado del correlativo. */
  code: z.string(),
  /** D-087: qué línea de transformación fabrica esta orden. */
  kind: z.enum(PRODUCTION_ORDER_KINDS),
  businessLine: z.enum(BUSINESS_LINES),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** Unidad del producto terminado: `NIU` en perfiles y planchas de catálogo, `MTR` a medida. */
  productUnit: z.string(),
  /**
   * D-122: espesor y peso por pieza **del SKU**, que es donde viven desde que la receta
   * dejó de ser la fuente. La terminal los lee para decir con qué bobina se rola y cuántos
   * kilos consume cada pieza, sin depender de que la orden tenga receta (las de coberturas
   * ya no la tienen).
   */
  productThicknessMm: z.string().nullable(),
  productPieceWeightKg: z.string().nullable(),
  status: z.enum(PRODUCTION_ORDER_STATUSES),
  targetPieces: z.number().int().nullable(),
  /** D-054: reserva consumida por esta OP. Siempre null en Fase 4. */
  reservationId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  /** Piezas buenas acumuladas de los reportes vigentes. */
  piecesReported: z.number().int(),
  /** Kilos asignados y kilos ya consumidos, sumando los flejes vivos de la OP. */
  assignedKg: z.string(),
  consumedKg: z.string(),
  /** Merma de proceso: solo tiene valor cuando la OP está cerrada (D-057, D-089). */
  scrapKg: z.string().nullable(),
  /** Solo en coberturas cerradas: los kilos que planta declaró que la bobina consumió (D-089). */
  consumedDeclaredKg: z.string().nullable(),
  /** Metros lineales buenos acumulados de los reportes vigentes. Null en drywall. */
  metersReported: z.string().nullable(),
  /**
   * D-146/D-148: metros lineales que el plan de corte encarga (`Σ cantidad × largo`). Null
   * en drywall, que no tiene plan de largos. Va en el DTO —y no derivado de `items` en la
   * pantalla— porque el **listado** omite `items` y la tarjeta de la orden tiene que decir
   * cuántos ML hay que producir sin pedir el detalle de cada orden.
   */
  planMeters: z.string().nullable(),
  materialCostPen: z.string().nullable(),
  overheadCostPen: z.string().nullable(),
  totalCostPen: z.string().nullable(),
  unitCostPen: z.string().nullable(),
  /**
   * D-122: `null` en una OP de **coberturas**, que desde entonces nace del pedido y del
   * producto y no de una receta. Las de drywall siguen trayendo la suya, que es lo que dice
   * qué fleje consumen.
   */
  bom: productBomSchema.nullable(),
  /** D-084: el plan de corte copiado del pedido, editable. Vacío en drywall. */
  items: z.array(roofingPieceSchema),
  /** Pedido del que nació la orden (D-084). Null en una corrida de stock de drywall. */
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  customerName: z.string().nullable(),
  consumptions: z.array(productionOrderConsumptionSchema),
  reports: z.array(productionReportSchema),
  /** D-124: día de negocio en que la corrida arrancó (Lima). */
  operationDate: z.string(),
  /** D-124: día de negocio del cierre. Null mientras la orden no se cierra. */
  closedOperationDate: z.string().nullable(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /**
   * D-154: avisos del agregado de materia prima que dejó **la operación que devolvió esta
   * respuesta** (montar una bobina, reportar planchas, cerrar la corrida). Es un dato de la
   * respuesta y no del recurso: un `GET` nunca lo trae, y por eso es opcional.
   *
   * Va acá y no en un DTO de resultado propio porque las tres operaciones devuelven la orden
   * entera: envolverla obligaría a cambiar cada llamador —incluidos veinte casos de E2E— para
   * leer un campo que casi ninguno mira.
   */
  rawMaterialWarnings: z.array(rawMaterialWarningSchema).optional(),
});
export type ProductionOrderDto = z.infer<typeof productionOrderSchema>;

export const productionOrderListItemSchema = productionOrderSchema
  .omit({ bom: true, items: true, consumptions: true, reports: true })
  .extend({ stripCount: z.number().int() });
export type ProductionOrderListItemDto = z.infer<typeof productionOrderListItemSchema>;

export const productionOrderQuerySchema = z.object({
  status: z.enum(PRODUCTION_ORDER_STATUSES).optional(),
  kind: z.enum(PRODUCTION_ORDER_KINDS).optional(),
  productId: z.string().uuid().optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type ProductionOrderQuery = z.infer<typeof productionOrderQuerySchema>;

/**
 * Un fleje candidato para una OP: los que `/planta` ofrece al operario. Sale del stock
 * de flejes (RF-42) filtrado por la receta del producto y por no estar tomado por otra OP.
 */
export const productionStripOptionSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  finishCode: z.string(),
  availableKg: z.string(),
  parentCoilCode: z.string().nullable(),
  /** Piezas que salen de ese saldo según la receta; lo que planta necesita ver. */
  estimatedPieces: z.number().int(),
});
export type ProductionStripOptionDto = z.infer<typeof productionStripOptionSchema>;
