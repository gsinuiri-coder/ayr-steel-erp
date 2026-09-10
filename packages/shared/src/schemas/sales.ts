import { z } from 'zod';
import { businessToday } from '../business-date';
// D-162: el IGV se mudó a `../tax`, junto con la traducción valor ⇄ precio, para que
// `schemas/pricing` —que se carga antes que este módulo— pueda usarlo sin cerrar un ciclo.
import { IGV_RATE_PCT } from '../tax';
import {
  Decimal,
  decimalStringSchema,
  MAX_VALUE,
  money,
  roundTo,
  toDecimal,
  toFixedString,
  type DecimalInput,
} from '../decimal';
import {
  BUSINESS_LINES,
  INVENTORY_ITEM_TYPES,
  QUOTATION_STATUSES,
  RESERVATION_STATUSES,
  SALES_ORDER_ORIGINS,
  SALES_ORDER_STATUSES,
} from '../enums';
import { reasonSchema } from './coil';
import { paginationQuerySchema } from './pagination';
import { piecesMeters, roofingPiecesSchema, roofingPieceSchema } from './roofing';

/**
 * Ciclo comercial de Fase 5a (RF-61, RF-62, RF-65, RF-69; D-064..D-069).
 *
 * Modelo en una línea: se cotiza (simulación de precio, sin efecto en inventario, D-054),
 * se **confirma** —y ahí, en una sola transacción, nacen el pedido y la reserva— y la
 * reserva descuenta disponible hasta que una OP la consume o alguien la libera.
 *
 * Todo el dominio comercial va **en soles** (D-064): no hay selector de moneda ni tipo de
 * cambio en ventas. El USD existe solo en compras (D-042).
 */

// --------------------------------------------------------------------------
// Constantes y aritmética compartida entre web y API
// --------------------------------------------------------------------------

/** Vigencia por defecto de una cotización, en días (D-069). El vendedor la puede cambiar. */
export const DEFAULT_QUOTATION_VALIDITY_DAYS = 7;

/** Tope de vigencia. Una cotización a más de un año no es una cotización. */
export const MAX_QUOTATION_VALIDITY_DAYS = 365;

/**
 * Tope de líneas de una cotización o pedido. Cada línea confirmada abre una reserva con
 * su propio lock de saldo dentro de la transacción de confirmación — mismo motivo por el
 * que el partido (RF-15) y la OP (D-060) topan sus hijas.
 */
export const MAX_SALES_ITEMS = 50;

/**
 * Días desde los que una reserva `ACTIVA` se considera vieja y la lista la marca (D-054:
 * sin vencimiento automático, alerta + liberación manual con permiso de ADMINISTRADOR).
 */
export const RESERVATION_STALE_DAYS = 30;

export interface SalesLineInput {
  qty: DecimalInput;
  unitPricePen: DecimalInput;
}

export interface SalesLineTotals {
  subtotal: Decimal;
  igv: Decimal;
  total: Decimal;
}

/**
 * Totales de una línea: precio sin IGV × cantidad, más IGV. Vive acá y no en el API para
 * que la cotización que el vendedor ve mientras tipea sea exactamente la que el API
 * guarda, igual que las constantes del partido (RF-15) y el kilo por pieza (D-059).
 */
export function salesLineTotals(line: SalesLineInput): SalesLineTotals {
  const subtotal = money(toDecimal(line.qty).times(toDecimal(line.unitPricePen)));
  const igv = money(subtotal.times(toDecimal(IGV_RATE_PCT)).div(100));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

/**
 * D-169: los totales de una línea cuyo **importe lo manda el papel**, no la cuenta.
 *
 * El subtotal es el del comprobante, tal cual; el IGV sale de ese subtotal con la misma
 * cuenta de siempre. El unitario **no** se recalcula desde el importe: sigue siendo el que la
 * línea trae, que es el que va al comprobante electrónico como `valorUnitario`.
 */
export function salesLineTotalsFromNet(netPen: DecimalInput): SalesLineTotals {
  const subtotal = money(netPen);
  const igv = money(subtotal.times(toDecimal(IGV_RATE_PCT)).div(100));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

/**
 * D-169: cuánto se separa el importe del papel de `cantidad × valor unitario`.
 *
 * Positivo cuando el papel dice más que la cuenta. Es el número que se muestra por línea y el
 * que se suma —en valor absoluto— para decidir si un documento está dentro de la tolerancia.
 */
export function roundingAdjustment(line: SalesLineInput & { subtotalPen: DecimalInput }): Decimal {
  return money(line.subtotalPen).minus(salesLineTotals(line).subtotal);
}

/**
 * D-169: el colchón fijo de la tolerancia de importación, en soles.
 *
 * Es el número que puso el dueño (± S/ 0.10 por documento) y sigue siendo el **piso**: un
 * documento chico se aguanta hasta diez céntimos aunque su aritmética no los explique. Lo que
 * no puede ser es el techo, por el motivo que dice `importRoundingTolerance`.
 */
export const IMPORT_ROUNDING_TOLERANCE_PEN = '0.10';

/**
 * D-169: cuánto puede separarse un documento importado de su propio recálculo, en soles.
 *
 * **Un plano de S/ 0.10 rechazaría justo los documentos que D-169 vino a poder importar.** El
 * unitario derivado se redondea a cuatro decimales (D-003), así que el producto se corre hasta
 * `cantidad × 0.00005` — invisible en una línea de tres unidades y de **S/ 0.12** en una de
 * 2 500 kg, que es el tamaño normal de una línea de acero. Con el techo fijo, la mitad del
 * archivo de agosto se caía con «una diferencia así no la produce el redondeo», que era
 * exactamente falso.
 *
 * Así que la tolerancia **es** esa cota: lo máximo que el redondeo puede explicar, más el
 * colchón del dueño. Por encima queda solo lo que el redondeo **no** puede haber producido —
 * la columna del precio con IGV donde va el valor, una cantidad con un cero de más, un
 * descuento de línea que el ERP no modela—, que es lo que hay que ver al importar y no al
 * cobrar. El `+ 1` de cada línea es el redondeo del propio producto a escala de dinero, que se
 * suma al del unitario.
 *
 * Se compara contra **la suma de los valores absolutos** de los ajustes y no contra el neto:
 * dos líneas que se van S/ 40 en sentidos opuestos suman cero y son justo el archivo a
 * rechazar.
 */
export function importRoundingTolerance(qtys: DecimalInput[]): Decimal {
  const explainable = qtys.reduce<Decimal>(
    (acc, qty) => acc.plus(toDecimal(qty).plus(1).times('0.00005')),
    new Decimal(0),
  );
  return Decimal.max(toDecimal(IMPORT_ROUNDING_TOLERANCE_PEN), money(explainable));
}

/** Suma de líneas ya calculadas. El total es Σ subtotales + Σ IGV, no Σ totales redondeados. */
export function salesTotals(lines: SalesLineInput[]): SalesLineTotals {
  const totals = lines.map(salesLineTotals);
  const subtotal = totals.reduce((acc, t) => acc.plus(t.subtotal), new Decimal(0));
  const igv = totals.reduce((acc, t) => acc.plus(t.igv), new Decimal(0));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

// D-130: `BUSINESS_TIME_ZONE` y `businessToday` viven en `../business-date`, un módulo hoja.
// Estaban acá, y cuando `schemas/operation` pasó a necesitarlas cerraron el ciclo
// `operation → sales → coil → operation`, que en CommonJS no lanza: deja `undefined` y borra
// en silencio los campos esparcidos con `{ ...backdatableFields }`.

/** `validUntil` por defecto: `issueDate` + N días, en formato `YYYY-MM-DD`. */
export function defaultValidUntil(
  issueDate: string,
  days: number = DEFAULT_QUOTATION_VALIDITY_DAYS,
): string {
  const d = new Date(`${issueDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * El `validUntil` que se guarda, **incluido el caso sin vencimiento** (D-157).
 *
 * Existe aparte de `defaultValidUntil` para que el `null` viaje explícito por el tipo: con
 * `days` opcional, un `undefined` accidental caía en la vigencia por defecto y una cotización
 * importada nacía con siete días que nadie pidió.
 */
export function quotationValidUntil(issueDate: string, days: number | null): string | null {
  return days === null ? null : defaultValidUntil(issueDate, days);
}

/**
 * `true` cuando la vigencia ya pasó. `null` —sin vencimiento, D-157— **nunca** vence: es la
 * única función que responde esta pregunta, para que la ausencia de fecha no se lea como
 * `'' < hoy` en algún lugar suelto y convierta lo que no vence en lo que venció siempre.
 */
export function isQuotationExpired(validUntil: string | null, today: string): boolean {
  return validUntil !== null && validUntil < today;
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), 'Fecha inválida');

const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });
const priceSchema = decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY });

/**
 * La unidad de un producto es texto libre en el maestro (`products.unit`, VarChar(20)):
 * el catálogo de SUNAT (`Unit`) es la guía, no una restricción, y hay productos cargados
 * por planilla con unidades fuera de él. El DTO la transporta tal cual.
 */
const unitStringSchema = z.string().max(20);

// --------------------------------------------------------------------------
// D-066 — reserva
// --------------------------------------------------------------------------

export const reservationSchema = z.object({
  id: z.string().uuid(),
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  salesOrderItemId: z.string().uuid(),
  customerName: z.string(),
  /** Coordenadas del ítem en el kardex: exactamente el par que usa `inventory_balances`. */
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  itemId: z.string().uuid(),
  /** SKU del producto o código de la bobina, según `itemType`. */
  itemLabel: z.string(),
  itemName: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  status: z.enum(RESERVATION_STATUSES),
  /**
   * Productos que pide el pedido de esta reserva. Es lo que la terminal de planta necesita
   * para ofrecer solo las reservas que la orden a crear puede atender: el API exige que la
   * reserva pertenezca a un pedido que encargó ese mismo producto.
   */
  orderProductIds: z.array(z.string().uuid()),
  /** OP que la consumió, si ya la consumió (D-060: `production_orders.reservation_id`). */
  productionOrderId: z.string().uuid().nullable(),
  productionOrderCode: z.string().nullable(),
  /** `true` cuando lleva `RESERVATION_STALE_DAYS` activa: la alerta de D-054. */
  isStale: z.boolean(),
  createdAt: z.string(),
  consumedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
});
export type ReservationDto = z.infer<typeof reservationSchema>;

export const reservationQuerySchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  itemId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
});
export type ReservationQuery = z.infer<typeof reservationQuerySchema>;

/** Liberación manual de una reserva (D-054): solo ADMINISTRADOR, siempre con motivo. */
export const releaseReservationSchema = z.object({ reason: reasonSchema });
export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

// --------------------------------------------------------------------------
// D-065 — líneas de cotización y de pedido
// --------------------------------------------------------------------------

/**
 * Una línea de cotización o de pedido.
 *
 * **La línea no dice qué reservar** (D-134). Lo decide el producto: una cobertura a medida
 * promete kilos del agregado de materia prima compatible (línea + color + espesor ±
 * tolerancia), una bobina completa se promete a sí misma y todo lo demás promete su propio
 * stock. El campo `reserveFromCoilId` existió hasta D-134 y le pedía al vendedor que
 * eligiera el rollo físico: una decisión que es de planta y que se toma semanas después.
 */
export const salesItemInputSchema = z.object({
  /**
   * Obligatorio salvo con `saleCoilId` (D-116): ahí el producto es siempre el SKU `trading`
   * de esa bobina (D-037) y el API lo resuelve solo, para que el web no tenga que conocer
   * el SKU generado antes de que la bobina exista.
   */
  productId: z.string().uuid().optional(),
  qty: qtySchema,
  /**
   * **Valor** de venta unitario, o sea SIN IGV (D-162), en soles. Opcional: sin él se usa el
   * valor de lista del maestro. Mandarlo es el override del vendedor (D-068), que queda
   * registrado junto al valor de lista vigente al momento de cotizar.
   *
   * El nombre dice «price» y el contenido es un valor: se mantiene porque es una columna con
   * datos reales desde 2026-09-07 y renombrarla no cambiaría ni un número. La palabra de
   * D-162 vale para lo que se ve y para lo que se escribe de acá en adelante.
   */
  unitPricePen: priceSchema.optional(),
  /**
   * D-161: **valor por metro lineal** (sin IGV) de una plancha de catálogo.
   *
   * Con él, el valor unitario de la línea deja de ser un número suelto y pasa a ser
   * `largo del SKU × este valor`: la plancha se negocia por metro —es como se compra el
   * acero— pero se cuenta, se reserva y se despacha en planchas.
   *
   * Es un campo **aparte** de `unitPricePen` y no el mismo con otro significado, a propósito:
   * los dos son un decimal en soles y el compilador nunca avisaría de la confusión, que en
   * una plancha de 3.60 m es un factor de 3.6 en el importe. Mandar los dos es un 400; el
   * API calcula el unitario y lo guarda.
   *
   * Solo lo acepta un producto `PLANCHA` con largo en el catálogo (`sellsByFixedLength`). El
   * importador de históricos (D-152) no lo manda: importa el valor unitario tal como salió.
   */
  valuePerMeterPen: priceSchema.optional(),
  /**
   * D-169: el **importe exacto de la línea tal como sale del papel** (valor de venta, SIN
   * IGV, en soles). Solo lo acepta el importador de históricos (D-152); en cualquier otra
   * ruta mandarlo es un 400.
   *
   * Existe porque un comprobante ya emitido **es** un documento legal y sus importes no se
   * recalculan: el archivo trae `VALOR DE VENTA` por línea, el ERP deriva el unitario
   * dividiéndolo entre la cantidad, y `cantidad × unitario` vuelve a dar el importe con una
   * diferencia de céntimos que crece con la cantidad —una línea de 2 500 kg redondea el
   * unitario a cuatro decimales y se va S/ 0.12 del papel—. Mientras el importe se
   * recalculaba, esa diferencia terminaba en la cuenta por cobrar de un comprobante que dice
   * otra cifra.
   *
   * Con esto, el importe **se copia** y lo que se deriva es el unitario, que es el orden
   * correcto: el unitario es el dato calculado del papel y el importe es el dato firmado.
   */
  netAmountPen: priceSchema.optional(),
  description: z.string().trim().max(240).optional(),
  /**
   * D-116 (Fase 7e): venta de una bobina completa (RF-73), virgen o con saldo parcial. El
   * producto (el SKU `trading` de D-037), la cantidad y la reserva se resuelven en el API a
   * partir del saldo **vivo** de esta bobina — nunca de lo que mande el formulario — porque
   * la regla del dueño es "siempre el saldo completo, nunca una fracción". `qty` viaja igual
   * en el input (el web la llena con el disponible que acaba de leer) pero el API la
   * recalcula. No se combina con los subítems de largo: vender el rollo tal cual y
   * fabricar a medida son dos líneas distintas.
   */
  saleCoilId: z.string().uuid().optional(),
  /**
   * D-083: los largos de una cobertura **a medida**. Con ellos, `qty` deja de ser un
   * número que el vendedor tipea y pasa a ser `Σ cantidad × largo` en metros: la línea es
   * compuesta y el precio se cotiza por metro lineal. Sin ellos la línea es simple, que es
   * el caso de un perfil, de una plancha de catálogo y de todo lo de trading.
   */
  pieces: roofingPiecesSchema.optional(),
});
export type SalesItemInput = z.infer<typeof salesItemInputSchema>;

const salesItemsSchema = z
  .array(salesItemInputSchema)
  .min(1, 'Al menos una línea')
  .max(MAX_SALES_ITEMS, `Máximo ${MAX_SALES_ITEMS} líneas`)
  .superRefine((items, ctx) => {
    items.forEach((item, i) => {
      // D-083: con subítems, la cantidad de la línea **es** la suma de los largos. Admitir
      // que difieran dejaría dos verdades sobre lo mismo y el kardex seguiría a una de las
      // dos sin decir cuál. Se comprueba acá para que el web lo diga antes de mandar.
      if (item.pieces !== undefined) {
        const expected = piecesMeters(item.pieces);
        if (!expected.equals(toDecimal(item.qty))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'qty'],
            message: `Los largos suman ${expected.toFixed(3)} m y la línea dice ${toDecimal(item.qty).toFixed(3)}`,
          });
        }
      }
      // D-161: el valor por metro y el valor por plancha son dos formas de decir el precio de
      // la misma línea, y una sale de la otra. Admitir las dos dejaría al API eligiendo cuál
      // gana en silencio, que es exactamente la clase de ambigüedad que la línea compuesta ya
      // rechaza más arriba.
      if (item.valuePerMeterPen !== undefined && item.unitPricePen !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'valuePerMeterPen'],
          message: 'Manda el valor por metro o el valor unitario, no los dos',
        });
      }
      if (item.valuePerMeterPen !== undefined && item.pieces !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'valuePerMeterPen'],
          message:
            'Una línea con detalle de largos ya cotiza por metro: no lleva valor por metro aparte',
        });
      }
      // D-116: una línea vende un producto del catálogo O una bobina completa, nunca las
      // dos cosas ni ninguna — sin producto el API no sabría qué facturar y con las dos
      // reservas a la vez no sabría cuál manda.
      if (item.saleCoilId !== undefined) {
        if (item.pieces !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'saleCoilId'],
            message: 'La venta de una bobina completa es una línea simple, sin largos',
          });
        }
      } else if (item.productId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'productId'],
          message: 'El producto es obligatorio',
        });
      }
    });
  });

export const salesItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** D-119: línea de negocio del producto de esta línea. Una cotización puede mezclar. */
  businessLine: z.enum(BUSINESS_LINES),
  description: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  /** Valor de lista del maestro al momento de cotizar (D-068). Null si no tenía. */
  listPricePen: z.string().nullable(),
  /** Valor unitario (sin IGV) efectivamente cotizado. Difiere del de lista si se editó. */
  unitPricePen: z.string(),
  /**
   * D-161: valor por metro con el que se cotizó una plancha de catálogo, del que sale
   * `unitPricePen = largo del SKU × este número`. Null en el resto de las líneas y en todo
   * lo cotizado antes de D-161.
   */
  valuePerMeterPen: z.string().nullable(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  /**
   * D-169: **el ajuste de redondeo de una línea importada**: lo que el importe del papel se
   * separa de `cantidad × valor unitario`. Cero en todo lo cotizado acá, que se calcula.
   *
   * No es una columna: se deriva de `subtotalPen − redondeo(qty × unitPricePen)`, que son
   * dos datos que ya están guardados. Guardarlo aparte habría dejado dos fuentes para el
   * mismo número y una forma de que discrepen (D-003); lo que hace falta es **verlo**, y para
   * eso alcanza con calcularlo al leer.
   */
  roundingAdjustmentPen: z.string(),
  /** D-083: los largos de una línea compuesta de cobertura a medida. Vacío en una simple. */
  pieces: z.array(roofingPieceSchema),
  /** Qué reservará (o reservó) esta línea. Ver `salesItemInputSchema`. */
  reserveItemType: z.enum(INVENTORY_ITEM_TYPES),
  reserveItemId: z.string().uuid(),
  reserveItemLabel: z.string(),
  reserveQty: z.string(),
  reserveUnit: unitStringSchema,
});
export type SalesItemDto = z.infer<typeof salesItemSchema>;

// --------------------------------------------------------------------------
// RF-61 — cotización
// --------------------------------------------------------------------------

/**
 * D-119 (Fase 7e): sin `businessLine` propio — una cotización o un pedido combina líneas
 * de cualquier línea de negocio. Cada línea trae la suya (vía su producto o, en una
 * bobina completa, D-037); el documento ya no exige que coincidan.
 */
export const createQuotationSchema = z.object({
  customerId: z.string({ required_error: 'El cliente es obligatorio' }).uuid(),
  issueDate: isoDateSchema,
  validityDays: z
    .number()
    .int()
    .min(1, 'Al menos un día de vigencia')
    .max(MAX_QUOTATION_VALIDITY_DAYS, `Máximo ${MAX_QUOTATION_VALIDITY_DAYS} días`)
    .default(DEFAULT_QUOTATION_VALIDITY_DAYS),
  notes: z.string().trim().max(500).optional(),
  items: salesItemsSchema,
});
export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;

/**
 * El alta de una cotización **desde adentro del API**, que sí puede crearla sin vencimiento
 * (D-157).
 *
 * Es un tipo y no una variante del schema **a propósito**: `createQuotationSchema` es el
 * cuerpo de `POST`/`PUT /sales/quotations`, así que admitir ahí `validityDays: null` le daría
 * a cualquier vendedor una cotización que no vence nunca, que el job diario no marca y que
 * `confirm()` no rechaza — justo lo que D-069 existe para impedir. El único llamador que pasa
 * `null` es el importador (D-152/D-158), y lo hace por código, no por HTTP.
 */
export type CreateQuotationInternalInput = Omit<CreateQuotationInput, 'validityDays'> & {
  validityDays: number | null;
};

/** Editar una cotización en `BORRADOR` (RF-66). Reemplaza las líneas completas. */
export const updateQuotationSchema = createQuotationSchema;
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;

/** Anular una cotización en cualquier estado no confirmado (RF-65). Motivo obligatorio. */
export const cancelQuotationSchema = z.object({ reason: reasonSchema });
export type CancelQuotationInput = z.infer<typeof cancelQuotationSchema>;

export const quotationSchema = z.object({
  id: z.string().uuid(),
  /** `COT-000123`, derivado del correlativo (D-068). */
  code: z.string(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  /** D-119: líneas de negocio distintas de sus ítems — puede tener más de una. */
  businessLines: z.array(z.enum(BUSINESS_LINES)),
  status: z.enum(QUOTATION_STATUSES),
  issueDate: z.string(),
  /** D-157: `null` = sin vencimiento. Una cotización así no vence nunca y siempre se confirma. */
  validUntil: z.string().nullable(),
  /** `true` cuando `validUntil` ya pasó, aunque el job todavía no la haya marcado. */
  isExpired: z.boolean(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  notes: z.string().nullable(),
  /** Pedido que nació de confirmarla (D-065). Null mientras no se confirma. */
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  /** Key del PDF en R2; el archivo se descarga por `GET /sales/quotations/:id/pdf`. */
  pdfKey: z.string().nullable(),
  items: z.array(salesItemSchema),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  emittedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type QuotationDto = z.infer<typeof quotationSchema>;

// D-119: el listado no carga `items` (perf: 500 cotizaciones con sus líneas es arrastrar
// miles de filas por pantallazo), así que tampoco puede derivar `businessLines` sin una
// consulta aparte por fila. Nadie lo muestra en la lista hoy — se omite acá y se recalcula
// en el detalle (`GET /sales/quotations/:id`), donde `items` ya viaja completo.
export const quotationListItemSchema = quotationSchema
  .omit({ items: true, businessLines: true })
  .extend({
    itemCount: z.number().int(),
  });
export type QuotationListItemDto = z.infer<typeof quotationListItemSchema>;

export const quotationQuerySchema = paginationQuerySchema.extend({
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  /** D-119: al menos una línea del documento es de esta línea de negocio. */
  businessLine: z.enum(BUSINESS_LINES).optional(),
  /** Búsqueda por código de cotización o nombre/documento del cliente (RF-84). */
  search: z.string().trim().max(80).optional(),
});
export type QuotationQuery = z.infer<typeof quotationQuerySchema>;

// --------------------------------------------------------------------------
// RF-62 — confirmación y pedido
// --------------------------------------------------------------------------

/**
 * Pedido directo, sin cotización previa (D-065). Solo se admite en líneas cuya cotización
 * es **opcional**; en las que la exigen (coberturas, RF-31) el API lo rechaza.
 */
export const createSalesOrderSchema = createQuotationSchema
  .omit({ validityDays: true })
  .extend({ promisedDeliveryDate: isoDateSchema.optional() });
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;

/**
 * Confirmar una cotización (RF-62). `promisedDeliveryDate` es la única entrada del vendedor:
 * D-096 solo la deja fijar en el acto de crear el pedido — antes no hay dónde guardarla (la
 * cotización no es un pedido) y después es de ADMINISTRADOR (`updatePromisedDeliveryDateSchema`).
 */
export const confirmQuotationSchema = z.object({
  promisedDeliveryDate: isoDateSchema.optional(),
});
export type ConfirmQuotationInput = z.infer<typeof confirmQuotationSchema>;

/** Anular un pedido: libera sus reservas activas (D-066). Motivo obligatorio. */
export const cancelSalesOrderSchema = z.object({ reason: reasonSchema });
export type CancelSalesOrderInput = z.infer<typeof cancelSalesOrderSchema>;

// --------------------------------------------------------------------------
// Fase 7 — cola de producción (RF-37, RF-38; D-092..D-096)
// --------------------------------------------------------------------------

/** Prioridad manual excepcional de la cola (D-094): motivo obligatorio en los dos sentidos. */
export const setSalesOrderPrioritySchema = z.object({
  priority: z.boolean(),
  reason: reasonSchema,
});
export type SetSalesOrderPriorityInput = z.infer<typeof setSalesOrderPrioritySchema>;

/** Solo ADMINISTRADOR, y solo después de que el pedido existe (D-096). `null` la borra. */
export const updatePromisedDeliveryDateSchema = z.object({
  promisedDeliveryDate: isoDateSchema.nullable(),
});
export type UpdatePromisedDeliveryDateInput = z.infer<typeof updatePromisedDeliveryDateSchema>;

export const QUEUE_SEMAPHORES = ['VENCIDO', 'PROXIMO', 'A_TIEMPO', 'SIN_FECHA'] as const;
export type QueueSemaphore = (typeof QUEUE_SEMAPHORES)[number];

/**
 * Semáforo de `fechaEntregaPrometida` (D-096). `PROXIMO` es hoy o mañana: la fecha es una
 * columna `DATE` sin hora, así que "menos de 48 h" solo se puede aproximar por calendario.
 * Siempre contra `businessToday()` (D-069) — nunca contra UTC.
 */
export function queueSemaphore(
  promisedDeliveryDate: string | null,
  today: string = businessToday(),
): QueueSemaphore {
  if (promisedDeliveryDate === null) return 'SIN_FECHA';
  if (promisedDeliveryDate < today) return 'VENCIDO';
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return promisedDeliveryDate <= tomorrow.toISOString().slice(0, 10) ? 'PROXIMO' : 'A_TIEMPO';
}

export const QUEUE_STATUSES = ['EN_COLA', 'EN_PRODUCCION'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * Una fila de la cola (D-093): pedido confirmado, con reserva de bobina activa sobre un
 * producto que se fabrica contra el pedido, y sin OP viva todavía. No es una tabla — se
 * recalcula en cada lectura a partir de `Reservation` + `ProductionOrder`.
 */
export const productionQueueEntrySchema = z.object({
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  salesOrderItemId: z.string().uuid(),
  reservationId: z.string().uuid(),
  customerName: z.string(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** Subítems (cantidad × largo), copiados o derivados igual que `create()` de la OP (D-084). */
  pieces: z.array(roofingPieceSchema),
  /** Kilos teóricos con la geometría de la bobina reservada al cotizar. `null` si esa bobina ya no existe. */
  theoreticalKg: z.string().nullable(),
  promisedDeliveryDate: z.string().nullable(),
  semaphore: z.enum(QUEUE_SEMAPHORES),
  createdAt: z.string(),
  priority: z.boolean(),
  priorityAt: z.string().nullable(),
  priorityByName: z.string().nullable(),
  priorityReason: z.string().nullable(),
});
export type ProductionQueueEntryDto = z.infer<typeof productionQueueEntrySchema>;

export const salesOrderSchema = z.object({
  id: z.string().uuid(),
  /** `PED-000123`, derivado del correlativo (D-068). */
  code: z.string(),
  quotationId: z.string().uuid().nullable(),
  quotationCode: z.string().nullable(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  /** D-119: líneas de negocio distintas de sus ítems — puede tener más de una. */
  businessLines: z.array(z.enum(BUSINESS_LINES)),
  status: z.enum(SALES_ORDER_STATUSES),
  /** D-141: `IMPORTED` cuando el pedido nació de un comprobante ya emitido afuera. */
  origin: z.enum(SALES_ORDER_ORIGINS),
  /**
   * D-141: el comprobante importado del que nació este pedido, y su número. `null` en todo
   * pedido creado en el ERP. Es la mitad "pedido → documento" del enlace bidireccional; la
   * otra la sostiene `fiscal_documents.sales_order_id`, que ya existía.
   */
  importedDocumentId: z.string().uuid().nullable(),
  importedDocumentNumber: z.string().nullable(),
  issueDate: z.string(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  notes: z.string().nullable(),
  items: z.array(salesItemSchema),
  reservations: z.array(reservationSchema),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  promisedDeliveryDate: z.string().nullable(),
  priority: z.boolean(),
  priorityReason: z.string().nullable(),
  priorityByName: z.string().nullable(),
  /** `null` cuando el pedido no tiene nada que fabricar, o ya dejó la cola (D-093). */
  queueStatus: z.enum(QUEUE_STATUSES).nullable(),
});
export type SalesOrderDto = z.infer<typeof salesOrderSchema>;

export const salesOrderListItemSchema = salesOrderSchema
  // `queueStatus` exige leer reservas + su OP viva por pedido (D-093); el listado solo
  // cuenta reservas activas (`activeReservations`) para no pagar ese costo por fila. La
  // cola en sí (`GET /sales/orders/queue`) es la vista barata para eso.
  // D-119: `businessLines` sale de `items`, que el listado tampoco carga (mismo motivo).
  // D-141: el número del comprobante importado exige un join más por fila y nadie lo
  // muestra en la lista; `origin` sí queda, que es una columna y es lo que se filtra.
  .omit({
    items: true,
    reservations: true,
    queueStatus: true,
    businessLines: true,
    importedDocumentId: true,
    importedDocumentNumber: true,
  })
  .extend({
    itemCount: z.number().int(),
    activeReservations: z.number().int(),
  });
export type SalesOrderListItemDto = z.infer<typeof salesOrderListItemSchema>;

export const salesOrderQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  /** D-119: al menos una línea del documento es de esta línea de negocio. */
  businessLine: z.enum(BUSINESS_LINES).optional(),
  search: z.string().trim().max(80).optional(),
});
export type SalesOrderQuery = z.infer<typeof salesOrderQuerySchema>;

// --------------------------------------------------------------------------
// Panel de stock en vivo (D-136)
// --------------------------------------------------------------------------

/**
 * Lo que el vendedor tiene disponible mientras arma la cotización.
 *
 * Reemplaza al selector "Reserva desde bobina" que D-134 eliminó, y no es lo mismo con otra
 * forma: aquel pedía **elegir un rollo**, este solo **informa**. La diferencia importa
 * porque la decisión que el selector pedía —cuál rollo— es de planta y se toma semanas
 * después; la que el vendedor sí tiene que tomar —¿alcanza el material?— necesita ver
 * cuánto hay, no cuál es.
 *
 * Existe como ruta propia de `sales` y no como un filtro de `/coils` porque **VENDEDOR no
 * tiene acceso a `/coils`**: esa ruta expone `unitCostPerKg`, `totalCost` y el proveedor,
 * que es justo lo que §3.4 le oculta al vendedor. Acá no viaja ni un campo de costo.
 */
export const rawMaterialStockSchema = z.object({
  colorId: z.string().uuid().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  thicknessMm: z.string(),
  /** Bobinas abiertas del grupo, sin contar las que una OP tiene montadas (D-060). */
  coils: z.number().int(),
  physicalKg: z.string(),
  /**
   * Lo comprometido que pesa sobre este grupo: las ventas de bobina entera sobre estos
   * rollos **más** las promesas genéricas de todo agregado compatible.
   *
   * Dos grupos de espesor vecino pueden compartir una misma promesa —la tolerancia los
   * alcanza a los dos— así que la suma de esta columna puede pasarse de lo realmente
   * prometido. Es a propósito: un panel que guía una promesa tiene que errar mostrando
   * **menos** disponible, nunca más.
   */
  reservedKg: z.string(),
  availableKg: z.string(),
  /**
   * Metros lineales que darían esos kilos, sumando rollo por rollo con su propio ancho y
   * espesor: `kg / (ancho × espesor × densidad del acabado)`. Es una referencia de venta,
   * no una promesa: el largo real depende del rollo que planta monte.
   */
  theoreticalMeters: z.string(),
});
export type RawMaterialStockDto = z.infer<typeof rawMaterialStockSchema>;

/** Disponible de un producto del catálogo, en su unidad de venta. */
export const productStockSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  availableQty: z.string(),
  /**
   * D-134: solo en una cobertura **a medida**, que no se atiende con stock del producto
   * sino con materia prima. Es el disponible del agregado que su línea va a prometer, ya
   * con la tolerancia de espesor aplicada — el mismo número contra el que la confirmación
   * va a decir que sí o que no.
   */
  rawMaterialAvailableKg: z.string().nullable(),
  rawMaterialLabel: z.string().nullable(),
  /** Kilos de bobina por metro lineal del producto. Null si no se fabrica a medida. */
  kgPerMeter: z.string().nullable(),
  /**
   * D-163: el **precio de venta mínimo** (CON IGV) de este SKU en su unidad de venta —
   * `costo promedio ÷ (1 − margen mínimo) × 1.18`— y el valor sin IGV equivalente.
   *
   * `null` cuando no hay piso que aplicar: un SKU que nunca entró al kardex (costo cero) o
   * una línea de negocio sin márgenes configurados. Es exactamente el mismo número que el
   * API va a exigir al guardar, calculado por la misma función: el formulario no puede
   * prometer un mínimo distinto del que el `POST` rechaza.
   *
   * El costo se puede despejar de acá (margen mínimo ÷ precio), y el margen lo lee todo el
   * equipo comercial. Es el costo de que el vendedor pueda ver su piso antes de tipear;
   * sin eso el piso solo se descubre chocando contra el 400.
   */
  minPricePen: z.string().nullable(),
  minValuePen: z.string().nullable(),
  /**
   * D-167: `false` en un producto de una línea `NOOP` —un servicio—, que no lleva
   * existencias. Viaja como bandera propia y no se deduce de `availableQty === '0.000'`
   * porque los dos ceros significan cosas distintas: el de un producto físico es "se acabó"
   * y hay que reponerlo, y el de un servicio es "esta pregunta no aplica". Mostrarlos
   * iguales fue lo que hizo que el mostrador leyera «0.000 disponibles» sobre un conformado
   * y creyera que faltaba stock de algo que no tiene stock.
   */
  carriesInventory: z.boolean(),
});
export type ProductStockDto = z.infer<typeof productStockSchema>;

export const stockPanelSchema = z.object({
  rawMaterial: z.array(rawMaterialStockSchema),
  products: z.array(productStockSchema),
});
export type StockPanelDto = z.infer<typeof stockPanelSchema>;

export const stockPanelQuerySchema = z.object({
  /** Sin filtro, el agregado de materia prima viene vacío: no hay una línea que mirar. */
  businessLine: z.enum(BUSINESS_LINES).optional(),
  /** Productos que el vendedor tiene puestos en las líneas, separados por coma. */
  productIds: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? [] : v.split(',')))
    .pipe(z.array(z.string().uuid()).max(50)),
});
export type StockPanelQuery = z.infer<typeof stockPanelQuerySchema>;

// --------------------------------------------------------------------------
// Bobinas vendibles completas (D-116, Fase 7e)
// --------------------------------------------------------------------------

/**
 * Una bobina DISPONIBLE para vender entera (D-116): abierta o cerrada, no en corte
 * tercerizado (D-050), no montada en una orden de producción (D-060) y sin otra venta que
 * ya la haya prometido. `availableQty` es el saldo que la línea va a reservar completo —
 * "siempre el saldo completo, nunca una fracción" es una decisión del dueño, no una opción
 * del formulario. Sin costos ni proveedor, mismo motivo que `rawMaterialStockSchema`: acá
 * llega VENDEDOR.
 */
export const sellableCoilSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  typeKey: z.string(),
  finishCode: z.string(),
  finishName: z.string(),
  colorCode: z.string().nullable(),
  colorName: z.string().nullable(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  status: z.enum(['OPEN', 'CLOSED']),
  availableQty: z.string(),
  /**
   * D-163: el **precio por kg mínimo** (con IGV) al que se puede vender este rollo, del
   * costo promedio de su propio saldo. `null` cuando no hay piso que aplicar.
   *
   * Sigue siendo cierto que acá no viaja el costo, pero de este número se despeja: es la
   * misma contrapartida asumida en D-163 para el panel de stock. Se manda porque una venta
   * de bobina entera es a precio negociado y el vendedor tipea el número a mano — sin el
   * mínimo a la vista, lo único que le dice que se pasó es el 400 al guardar.
   */
  minPricePen: z.string().nullable(),
  /**
   * D-170: el **costo promedio por kilo** de este rollo, que es a lo que el kardex lo va a
   * dar de baja cuando la venta lo despache.
   *
   * Viaja porque una venta de bobina entera es a precio negociado y a ojo: el vendedor tipea
   * un número por kg y hasta ahora lo único que le decía si se había pasado era el piso —del
   * que este costo ya se despejaba (D-163)—. Mostrarlo directo no revela nada nuevo y evita
   * la aritmética mental; lo que sigue sin viajar es el costo del **documento** de compra, el
   * proveedor y el landed cost, que es lo que §3.4 le oculta al vendedor.
   */
  avgCostPen: z.string().nullable(),
});
export type SellableCoilDto = z.infer<typeof sellableCoilSchema>;

export const sellableCoilQuerySchema = z.object({
  /** Sin filtro trae bobinas de Drywall y Metallic Roofing, las únicas líneas con bobina. */
  businessLine: z.enum(BUSINESS_LINES).optional(),
  search: z.string().trim().max(80).optional(),
});
export type SellableCoilQuery = z.infer<typeof sellableCoilQuerySchema>;

// --------------------------------------------------------------------------
// D-067 — consulta de RUC/DNI contra apis.net.pe
// --------------------------------------------------------------------------

/**
 * Resultado de la búsqueda por documento. `found: false` **no es un error**: la captura
 * manual sigue disponible y el formulario no se bloquea (mismo criterio que el fallback
 * del tipo de cambio, D-029). `reason` explica por qué no hubo datos, para que la UI
 * distinga "no existe ese RUC" de "el servicio no respondió".
 */
export const documentLookupSchema = z.object({
  found: z.boolean(),
  docType: z.string(),
  docNumber: z.string(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  reason: z.enum(['OK', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_CONFIGURED']),
});
export type DocumentLookupDto = z.infer<typeof documentLookupSchema>;

/** Serialización de un total de línea a los strings del DTO (D-003). */
/**
 * D-169: los totales de un documento a partir de **los importes que sus líneas ya tienen**.
 *
 * Es la contracara de `salesTotals`, que los deriva de `cantidad × unitario`. Se usa cuando las
 * líneas traen un importe que no hay que volver a calcular —el de un comprobante importado, que
 * es el del papel— y por eso suma `subtotal` e `igv` por separado, nunca los totales ya
 * redondeados, exactamente como `documentTotals` en ventas.
 */
export function sumLineTotals(
  lines: readonly { subtotalPen: DecimalInput; igvPen: DecimalInput }[],
): SalesLineTotals {
  const subtotal = lines.reduce<Decimal>(
    (acc, l) => acc.plus(toDecimal(l.subtotalPen)),
    new Decimal(0),
  );
  const igv = lines.reduce<Decimal>((acc, l) => acc.plus(toDecimal(l.igvPen)), new Decimal(0));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

export function serializeSalesTotals(totals: SalesLineTotals): {
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
} {
  return {
    subtotalPen: toFixedString(totals.subtotal, 'MONEY'),
    igvPen: toFixedString(totals.igv, 'MONEY'),
    totalPen: toFixedString(totals.total, 'MONEY'),
  };
}

/** Redondeo a kilos de una cantidad de reserva; centraliza la escala (D-003). */
export const reserveQty = (v: DecimalInput): Decimal => roundTo(v, 'KG');
