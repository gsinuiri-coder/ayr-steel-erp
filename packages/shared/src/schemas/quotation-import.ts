import { z } from 'zod';
import {
  Decimal,
  decimalStringSchema,
  MAX_VALUE,
  SCALE,
  toDecimal,
  toFixedString,
  type DecimalInput,
} from '../decimal';
import {
  MAX_PIECE_LENGTH_MM,
  MIN_PIECE_LENGTH_MM,
  roofingPiecesSchema,
  type PieceLike,
} from './roofing';
import { DERIVED_UNIT_VALUE_DECIMALS } from './sales';

/**
 * Importador masivo de cotizaciones (D-152).
 *
 * Reemplaza a los importadores directos que D-150 eliminó, y la diferencia es toda la idea:
 * **no escribe contra la tabla, escribe una cotización**. Cada fila del Excel termina en
 * `QuotationsService.createInTx`, la misma que usa el formulario, así que hereda sus
 * validaciones en vez de copiarlas — que es exactamente lo que los importadores viejos no
 * hacían y por lo que cada uno terminó con su propia reversa y su propio incidente.
 *
 * De ahí en adelante la carga sigue por el flujo real: emitir → confirmar → pedido, reserva
 * y OP → despacho → venta. El importador **deja la cotización en BORRADOR** y no avanza sola:
 * confirmar compromete inventario, y eso se mira documento por documento.
 *
 * Dos reglas duras de esta puerta:
 *
 * - **Cero creación silenciosa.** Un cliente o un producto que no está en el maestro **detiene
 *   la fila** con su motivo; no se crea nada de prestado. Es la lección de D-138, que
 *   auto-creaba clientes y por eso necesitó un purge.
 * - **Nada se adivina.** El archivo trae metros lineales pero no el plan de corte; cuando el
 *   plan por defecto no cabe en una plancha, la fila se marca y el plan se escribe a mano.
 */

// --------------------------------------------------------------------------
// El contrato de columnas: el export real del sistema de facturación del dueño
// --------------------------------------------------------------------------

/**
 * Encabezados del archivo, tal cual vienen. Se comparan sin tildes ni mayúsculas
 * (`parse-spreadsheet.ts`), pero se declaran como están para que el mensaje de "falta la
 * columna X" nombre lo que el usuario ve en su Excel.
 */
export const QUOTATION_IMPORT_COLUMNS = {
  issueDate: 'F. EMISIÓN',
  docType: 'TIPO COMPROBANTE',
  documentKey: 'SERIE - NÚMERO',
  customer: 'CLIENTE',
  currency: 'MONEDA',
  exchangeRate: 'TIPOCAMBIO',
  adjustedDocument: 'DOCUMENTO AJUSTADO',
  sku: 'CÓDIGO PRODUCTO',
  productName: 'NOMBRE PRODUCTO',
  unit: 'UNIDAD MEDIDA',
  qty: 'CANTIDAD',
  netAmount: 'VALOR DE VENTA',
  /**
   * D-255: el IGV y el importe con IGV de la línea. **Opcionales**: cuando el archivo los trae y
   * cuadran con el valor de venta (`paperTriplet`), los tres importes del papel se guardan tal
   * cual; si faltan o no cuadran, el IGV se calcula como siempre.
   */
  igv: 'IGV',
  totalAmount: 'PRECIO DE VENTA',
} as const;

/** Las que sin ellas el archivo no es este archivo. */
export const QUOTATION_IMPORT_REQUIRED_COLUMNS: readonly string[] = [
  QUOTATION_IMPORT_COLUMNS.issueDate,
  QUOTATION_IMPORT_COLUMNS.documentKey,
  QUOTATION_IMPORT_COLUMNS.customer,
  QUOTATION_IMPORT_COLUMNS.sku,
  QUOTATION_IMPORT_COLUMNS.qty,
  QUOTATION_IMPORT_COLUMNS.netAmount,
];

/**
 * Unidades del archivo → unidades UN/EDI del ERP. Lo que no esté acá **no se adivina**: la
 * fila se marca y se resuelve mapeando el SKU a un producto, que es quien tiene la unidad
 * de verdad. Este mapa solo sirve para avisar cuando la unidad del papel y la del producto
 * no se parecen.
 */
export const QUOTATION_IMPORT_UNITS: Record<string, string> = {
  'METRO LINEAL': 'MTR',
  KILOGRAMO: 'KGM',
  UNIDAD: 'NIU',
  TONELADA: 'TNE',
  // D-385: las variantes de tonelada que el papel puede traer, y los códigos UN/EDI tal cual
  // (no son una interpretación: son la unidad misma).
  TN: 'TNE',
  TON: 'TNE',
  TNE: 'TNE',
  MTR: 'MTR',
  KGM: 'KGM',
  NIU: 'NIU',
};

/** D-385: kilos por tonelada. */
export const KG_PER_TONNE = 1000;

/**
 * D-385: la unidad UN/EDI de la columna `UNIDAD MEDIDA`, sin mayúsculas ni espacios de más.
 * `null` si la celda viene vacía (la columna es opcional y entonces no hay nada que convertir);
 * `undefined` si trae algo que no está en {@link QUOTATION_IMPORT_UNITS}: eso **no se adivina**
 * y la fila queda para revisión.
 */
export function importPaperUnit(raw: string): string | null | undefined {
  const key = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  if (key === '') return null;
  return QUOTATION_IMPORT_UNITS[key];
}

/**
 * D-385: la cantidad de la fila en la unidad del producto. Solo hay una conversión: el papel
 * dice **tonelada** y el producto se vende en **kilos** (las bobinas): la cantidad se multiplica
 * por mil. El valor de venta del papel no se toca —manda el importe (D-169)— y el unitario, que
 * sale de dividirlo entre la cantidad, queda solo por kilo. Un producto que se vende en toneladas
 * (el servicio de conformado) conserva la cantidad del papel, decisión del dueño 2026-10-04.
 */
export function importQtyInProductUnit(
  qty: Decimal,
  paperUnit: string | null | undefined,
  productUnit: string | null,
): { qty: Decimal; convertedFromTonnes: boolean } {
  if (paperUnit === 'TNE' && productUnit === 'KGM') {
    return { qty: qty.times(KG_PER_TONNE), convertedFromTonnes: true };
  }
  return { qty, convertedFromTonnes: false };
}

/** Tope de filas de un archivo. Una carga mensual real ronda las 150. */
export const MAX_QUOTATION_IMPORT_ROWS = 1_000;

/**
 * Cuántos documentos desconocidos se consultan contra el padrón en un preview (D-158).
 *
 * El archivo de un mes trae unos 48 clientes distintos y la cuota de apis.net.pe es **una
 * sola para todo el sistema** —la comparte con el tipo de cambio (D-029)—, así que un archivo
 * armado a mano con mil documentos inventados no puede quemarla entera. Por encima del tope
 * las filas restantes quedan como estaban: sin cliente y con su error de siempre.
 */
export const MAX_PADRON_LOOKUPS = 80;

/** Consultas al padrón en paralelo. Cada una tarda hasta 5 s y son 48 en un archivo real. */
export const PADRON_LOOKUP_CONCURRENCY = 6;

/**
 * `20606364335` → `RUC`, `41234567` → `DNI`. `null` cuando no es ninguno de los dos.
 *
 * El carné de extranjería no se deriva del número (6 a 12 caracteres, se solapa con todo) ni
 * está en ningún padrón consultable: esa fila se resuelve con el alta express.
 */
export function importDocTypeOf(docNumber: string): 'RUC' | 'DNI' | null {
  if (/^\d{11}$/.test(docNumber)) return 'RUC';
  if (/^\d{8}$/.test(docNumber)) return 'DNI';
  return null;
}

// --------------------------------------------------------------------------
// El plan de corte por defecto
// --------------------------------------------------------------------------

export type DefaultPlan =
  { ok: true; pieces: PieceLike[] } | { ok: false; reason: string } | { ok: 'not-needed' };

/**
 * El plan de corte de una línea a medida cuando el archivo no lo trae (D-152).
 *
 * **Una sola plancha del largo total**, que es lo que el dueño pidió y lo único que no
 * inventa nada: el Excel dice cuántos metros lineales se vendieron y nada más. Cuando esos
 * metros no caben en una plancha —el tope es de 20 m y hay líneas de 1 832— la función
 * **falla en vez de repartir**: elegir por el operario que fueron planchas de 6 m sería
 * escribir en el plan de corte un dato que el archivo no dice, y ese plan es después el tope
 * duro de lo que planta puede reportar (D-146).
 */
export function defaultRoofingPlan(meters: Decimal | string): DefaultPlan {
  const lengthMm = toDecimal(meters).times(1000);
  if (lengthMm.lte(0)) {
    return { ok: false, reason: 'La cantidad tiene que ser mayor a cero para derivar el plan.' };
  }
  if (lengthMm.lt(MIN_PIECE_LENGTH_MM)) {
    return {
      ok: false,
      reason: `El plan por defecto sería 1 × ${toDecimal(meters).toFixed(2)} m y una plancha no baja de ${MIN_PIECE_LENGTH_MM / 1000} m: escribe el plan de corte real.`,
    };
  }
  if (lengthMm.gt(MAX_PIECE_LENGTH_MM)) {
    return {
      ok: false,
      reason: `El plan por defecto sería 1 × ${toDecimal(meters).toFixed(2)} m y una plancha no pasa de ${MAX_PIECE_LENGTH_MM / 1000} m: escribe el plan de corte real.`,
    };
  }
  return { ok: true, pieces: [{ lengthMm: lengthMm.toFixed(2), qty: 1 }] };
}

/**
 * El plan que el preview **propone** cuando el archivo no trae ninguno: `1 × los ML de la
 * línea`, escrito en el mismo formato que se tipea en la celda (`1x81.9`).
 *
 * Es una sugerencia, no un plan válido: cuando esos metros no caben en una plancha —el tope
 * son 20 m y el archivo del dueño tiene líneas de 1 832— la celda queda con el error de
 * siempre y hay que corregirla. **La regla de D-152 sigue viva**: el importador no reparte
 * 1 832 m en planchas de 6 por su cuenta, porque el plan de corte es después el tope duro de
 * lo que planta puede reportar (D-146). Lo único que cambia es que el campo llega **relleno**
 * con la cifra del papel en vez de vacío, así que corregirlo es editar un número y no
 * transcribirlo.
 */
export function suggestedRoofingPlanText(meters: Decimal | string): string {
  const value = toDecimal(meters);
  if (value.lte(0)) return '';
  // Sin ceros a la derecha: la cantidad viaja con tres decimales (`81.900`) y el plan se
  // relee con `cantidad x largo`, donde `81.9` es lo que una persona escribiría.
  return `1x${value.toFixed(3).replace(/\.?0+$/, '')}`;
}

// --------------------------------------------------------------------------
// El unitario de la fila: diez decimales (P14 §3.5)
// --------------------------------------------------------------------------

/**
 * P14 §3.5 (decisión del dueño, 2026-10-01): el unitario de una fila del importador viaja y se
 * edita con **todos sus decimales**, hasta los diez del unitario derivado (D-255,
 * `DERIVED_UNIT_VALUE_DECIMALS`).
 *
 * El archivo no trae unitario: trae el valor de venta, y el unitario sale de dividirlo entre la
 * cantidad. Cortarlo a cuatro decimales no rompía la fila intacta —ahí manda el importe del
 * papel (D-169)— pero sí la editada: al tocar la cantidad o el precio el importe se recalcula
 * desde el unitario, y `146 × 16.2893` daba 2 378.2378 donde el papel decía 2 378.23488
 * (2 378.2349 a escala de dinero). Con el unitario entero, `146 × 16.28928` vuelve a 2 378.2349.
 *
 * Es **solo de esta puerta**: el resto de las rutas sigue recibiendo el unitario a la escala de
 * dinero (D-003), y la cotización guarda el suyo a cuatro decimales para mostrar.
 */
export const IMPORT_UNIT_PRICE_DECIMALS = DERIVED_UNIT_VALUE_DECIMALS;

/** Un unitario tipeado en la fila: punto decimal y hasta diez decimales. */
export const IMPORT_UNIT_PRICE_PATTERN = /^\d+(\.\d{1,10})?$/;

/**
 * El unitario de la fila como texto: redondeado a diez decimales (al medio hacia arriba) y sin
 * los ceros a la derecha que pasen de los cuatro de dinero. `100` → `100.0000`, `16.28928` →
 * `16.28928`, `4179.13 ÷ 3500` → `1.1940371429`: la fila de siempre se sigue viendo igual y la
 * que tiene más decimales los muestra.
 */
export function importUnitPriceText(value: DecimalInput): string {
  const fixed = toDecimal(value)
    .toDecimalPlaces(IMPORT_UNIT_PRICE_DECIMALS, Decimal.ROUND_HALF_UP)
    .toFixed(IMPORT_UNIT_PRICE_DECIMALS);
  const [integer = '0', fraction = ''] = fixed.split('.');
  return `${integer}.${fraction.replace(/0+$/, '').padEnd(SCALE.MONEY, '0')}`;
}

/**
 * El importe de una fila **editada** (sin el del papel): `redondeo(cantidad × unitario)` a escala
 * de dinero, con el unitario tal como está —hasta diez decimales—. Es la misma cuenta que hace el
 * API con la línea que llega sin `netAmountPen` (`salesLineTotals`), así que lo que la pantalla
 * muestra es lo que se va a crear. `null` cuando la cantidad o el unitario no son legibles.
 */
export function importRowNetPen(qty: string, unitPricePen: string): string | null {
  const q = qty.trim();
  const unit = unitPricePen.trim();
  if (!/^\d+(\.\d+)?$/.test(q) || !IMPORT_UNIT_PRICE_PATTERN.test(unit)) return null;
  return toFixedString(toDecimal(q).times(toDecimal(unit)), 'MONEY');
}

/**
 * El unitario de la fila en el confirm. Mismo contrato que `decimalStringSchema('MONEY')` —un
 * decimal real, mayor a cero y bajo el tope de la columna— pero a diez decimales en vez de
 * cuatro (P14 §3.5).
 */
const importUnitPriceSchema = z
  .string({ required_error: 'Este valor es obligatorio' })
  .trim()
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Debe ser un número decimal (ej: 12.5)')
  .transform((v) => importUnitPriceText(v))
  .refine((v) => toDecimal(v).gt(0), 'Debe ser mayor a cero')
  .refine(
    (v) => toDecimal(v).lte(MAX_VALUE.MONEY),
    `El valor máximo admitido es ${String(MAX_VALUE.MONEY)}`,
  );

// --------------------------------------------------------------------------
// La fila: lo que el preview muestra y lo que vuelve al confirmar
// --------------------------------------------------------------------------

/**
 * Lo que hay que decirle al usuario de una fila, uno por campo para pintarlo en su celda.
 *
 * La severidad no es decoración: un `error` **bloquea** la importación y un `warning` solo
 * avisa. Sin la distinción, un aviso legítimo —"el archivo dice METRO LINEAL y este SKU se
 * vende en unidades"— dejaba el botón apagado para siempre sobre una fila que el API acepta
 * sin problema, y la única salida era quitarla.
 */
export const quotationImportIssueSchema = z.object({
  // D-385: `unit` es la unidad del papel; no depende de lo que se edite en la fila y la pantalla
  // lo conserva siempre.
  field: z.enum(['customer', 'product', 'qty', 'unit', 'unitPrice', 'pieces', 'row']),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
});
export type QuotationImportIssueDto = z.infer<typeof quotationImportIssueSchema>;

/**
 * Lo que el navegador manda de vuelta al confirmar: la fila **ya resuelta y editada**. El
 * texto crudo del Excel no vuelve — lo que decide qué se crea es el id del cliente, el del
 * producto y los números, no el nombre que traía el papel.
 */
/**
 * El documento con el que se pide dar de alta un cliente **desde el padrón** (D-158).
 *
 * Viaja **sin nombre a propósito**: el nombre lo trae el servidor de la consulta al padrón,
 * no el navegador. Aceptar la razón social del cliente sería exactamente la creación de
 * datos inventados que D-152 prohibió — bastaría con editar el request para dar de alta a
 * "PROVEEDOR S.A.C." bajo un RUC ajeno.
 */
export const quotationImportPadronRefSchema = z.object({
  docType: z.enum(['RUC', 'DNI']),
  docNumber: z
    .string()
    .trim()
    .regex(/^\d{8,11}$/, 'El documento son 8 u 11 dígitos'),
});
export type QuotationImportPadronRef = z.infer<typeof quotationImportPadronRefSchema>;

/** Lo que el padrón respondió sobre un documento que el maestro no tiene (D-158). */
export const quotationImportPadronSchema = quotationImportPadronRefSchema.extend({
  /** Razón social o nombre tal como lo devolvió el padrón. Nunca se compone acá. */
  name: z.string(),
  address: z.string().nullable(),
});
export type QuotationImportPadronDto = z.infer<typeof quotationImportPadronSchema>;

export const quotationImportRowInputSchema = z.object({
  /** Fila del Excel (1-based sobre los datos, sin contar el encabezado). Solo para el reporte. */
  rowNumber: z.number().int().positive(),
  /** `FFA1-1349`: agrupa las líneas de una misma cotización y viaja a las observaciones. */
  documentKey: z.string().trim().min(1).max(60),
  /** D-124: día de negocio de la cotización, tomado de `F. EMISIÓN`. */
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en formato YYYY-MM-DD'),
  /**
   * El cliente del maestro. `null` **solo** cuando la fila viene con `newCustomer`: el
   * servicio exige uno de los dos y rechaza el documento entero si no llega ninguno.
   */
  customerId: z.string().uuid().nullable(),
  /** D-158: dar de alta al cliente desde el padrón al confirmar. Excluyente con `customerId`. */
  newCustomer: quotationImportPadronRefSchema.optional(),
  productId: z.string().uuid(),
  qty: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }),
  /**
   * Precio unitario **sin IGV y en soles**, ya convertido si el documento venía en dólares.
   * Hasta diez decimales (P14 §3.5): en la fila editada el importe se recalcula desde él.
   */
  unitPricePen: importUnitPriceSchema,
  /**
   * D-169: el **importe de la línea tal como está en el papel** (valor de venta, sin IGV, en
   * soles). Es el que se persiste como subtotal; `unitPricePen` es la cuenta derivada.
   *
   * Viaja como campo propio y no se recalcula desde el unitario porque ahí está el defecto
   * que D-169 cierra: dividir el importe entre la cantidad, redondear a cuatro decimales y
   * volver a multiplicar no devuelve el importe, y la diferencia crece con la cantidad. En un
   * comprobante ya emitido el importe es el dato firmado y el unitario el dato calculado.
   *
   * **Opcional, y la ausencia significa algo**: la fila cuya cantidad o cuyo precio el usuario
   * editó en el preview ya no responde al importe del papel, así que viaja sin él y el
   * importe se recalcula desde lo que esa persona tipeó: `redondeo(cantidad × unitario)`, con el
   * unitario a diez decimales (P14 §3.5). Mandarlo igual habría hecho que
   * corregir un precio no cambiara el importe —y el rechazo por tolerancia habría culpado al
   * archivo de una diferencia que introdujo la corrección.
   */
  netAmountPen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }).optional(),
  /**
   * D-255: el IGV y el importe con IGV del papel. Viajan juntos, y solo con `netAmountPen`: una
   * fila editada pierde los tres.
   */
  igvAmountPen: decimalStringSchema('MONEY', { max: MAX_VALUE.MONEY }).optional(),
  totalAmountPen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }).optional(),
  /**
   * D-254 (R1): la bobina del pool que atiende una línea con código de bobina. La elige el
   * preview cuando hay una sola candidata (o una sola con el saldo exacto del papel); si no, la
   * elige quien revisa. Con ella la línea es una venta de bobina y `productId` es el producto de
   * venta canónico de esa bobina.
   */
  saleCoilId: z.string().uuid().optional(),
  description: z.string().trim().max(240).optional(),
  /** D-083: los largos de una cobertura a medida. Ausente en toda línea simple. */
  pieces: roofingPiecesSchema.optional(),
});
export type QuotationImportRowInput = z.infer<typeof quotationImportRowInputSchema>;

/** D-254: una bobina del pool que puede atender la línea, para el selector del preview. */
export const coilPoolCandidateSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  widthMm: z.string(),
  balanceKg: z.string(),
  /** D-385 (A): con tolerancia de espesor, la bobina puede ser de otro SKU que el del papel. */
  thicknessMm: z.string(),
  /** El producto de venta de esta bobina: la línea lo toma si se la elige. */
  productId: z.string().uuid(),
  productSku: z.string(),
});

/** D-385 (A): un producto de venta de bobina existente dentro de la tolerancia del papel. */
export const coilProductOptionSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  thicknessMm: z.string(),
});
export type CoilProductOptionDto = z.infer<typeof coilProductOptionSchema>;
export type CoilPoolCandidateDto = z.infer<typeof coilPoolCandidateSchema>;

/** Una fila del preview: lo de arriba más lo que hace falta para pintarla y decidirla. */
export const quotationImportRowSchema = quotationImportRowInputSchema
  .extend({
    customerId: z.string().uuid().nullable(),
    productId: z.string().uuid().nullable(),
    /**
     * D-158: lo que el padrón contestó sobre el documento del papel cuando el maestro no lo
     * tiene. `null` es "no hay a quién dar de alta" —el padrón no respondió, el documento no
     * existe, o el cliente ya está en el maestro—, y en ese caso la fila queda con su error
     * normal y se resuelve con el alta express.
     */
    padron: quotationImportPadronSchema.nullable(),
    /** Texto crudo del archivo, para que la fila sea reconocible aunque no resuelva. */
    rawCustomer: z.string(),
    rawSku: z.string(),
    rawProductName: z.string(),
    rawUnit: z.string(),
    /** Nombre del cliente y del producto ya resueltos; null cuando no se encontraron. */
    customerName: z.string().nullable(),
    productSku: z.string().nullable(),
    productName: z.string().nullable(),
    /** Unidad del producto resuelto. Es lo que decide si la línea lleva largos (D-131). */
    productUnit: z.string().nullable(),
    /**
     * `true` cuando el producto se vende **por metro lineal** y por lo tanto la línea exige
     * los largos (`sellsByLength` de `sales-lines.ts`). Lo decide la **unidad**, no el subtipo
     * de cobertura: son dos preguntas distintas y confundirlas es exactamente D-131.
     */
    needsPieces: z.boolean(),
    /**
     * D-252/D-254 (R1): la fila trae un **código de bobina** que el normalizador interpretó. Su
     * producto es el SKU canónico y su disponibilidad es el pool; nunca un producto suelto.
     */
    coilLine: z.boolean(),
    /** D-254: las bobinas del pool que pueden atender la línea. Vacío fuera de una línea de bobina. */
    coilCandidates: z.array(coilPoolCandidateSchema),
    /** D-254: lo disponible en el pool, en kg. `null` fuera de una línea de bobina. */
    coilPoolAvailableKg: z.string().nullable(),
    saleCoilId: z.string().uuid().nullable(),
    /** D-385 (A): el SKU canónico que dice el papel (`BOB030AZUL`). `null` fuera de bobina. */
    paperCoilSku: z.string().nullable(),
    /**
     * D-385 (A): los productos de venta existentes del mismo color con espesor dentro de la
     * tolerancia del papel. Sin bobina elegida, la línea va con el del papel si existe; si no,
     * con el único de esta lista, y si hay varios lo elige quien revisa.
     */
    coilProductOptions: z.array(coilProductOptionSchema),
    /**
     * D-385: la cantidad tal como venía en el papel cuando se convirtió (tonelada → kg), para que
     * la vista previa muestre «4.192 TONELADA → 4,192 kg». `null` si no hubo conversión.
     */
    unitConversion: z.object({ paperQty: z.string(), paperUnit: z.string() }).nullable(),
    currency: z.string(),
    /** Solo informativo: con qué tipo de cambio se llevó el precio a soles. */
    exchangeRate: z.string().nullable(),
    issues: z.array(quotationImportIssueSchema),
    /**
     * Filas que el importador **no** trae y por qué (una nota de crédito, un documento
     * ajustado). Vienen en la respuesta para que se vean, pero no se pueden confirmar.
     */
    excludedReason: z.string().nullable(),
  })
  // El preview manda strings crudos: una fila con la cantidad vacía o el importe ilegible
  // tiene que **llegar a la pantalla** con su marca, no morir en el parseo del archivo entero.
  .omit({
    qty: true,
    unitPricePen: true,
    netAmountPen: true,
    igvAmountPen: true,
    totalAmountPen: true,
  })
  .extend({
    qty: z.string(),
    unitPricePen: z.string(),
    netAmountPen: z.string(),
    /** D-255: cadena vacía cuando el archivo no los trae o no cuadran. */
    igvAmountPen: z.string(),
    totalAmountPen: z.string(),
  });
export type QuotationImportRowDto = z.infer<typeof quotationImportRowSchema>;

export const quotationImportPreviewSchema = z.object({
  fileName: z.string(),
  rows: z.array(quotationImportRowSchema),
  /** Cuántas cotizaciones saldrían: documentos distintos entre las filas importables. */
  quotations: z.number().int(),
  excluded: z.number().int(),
  withIssues: z.number().int(),
});
export type QuotationImportPreviewDto = z.infer<typeof quotationImportPreviewSchema>;

/**
 * La confirmación (D-152). **Todo o nada**, con el error de cada fila cuando alguna falla:
 * el mismo contrato que la tanda de planta (D-147), y por el mismo motivo — quien revisó 141
 * filas necesita corregirlas de una vez y no descubrir un error por intento.
 */
export const importQuotationsSchema = z
  .object({
    rows: z
      .array(quotationImportRowInputSchema)
      .min(1, 'No hay ninguna fila para importar')
      .max(MAX_QUOTATION_IMPORT_ROWS, `Máximo ${MAX_QUOTATION_IMPORT_ROWS} filas por archivo`),
  })
  /**
   * D-158: `customerId` y `newCustomer` son **excluyentes**, y el schema lo impone en vez de
   * dejarlo escrito en un comentario. La fila con los dos puestos es el resultado normal de
   * cambiar de opinión en el preview —el comprobante llegó como "nuevo desde padrón" y el
   * usuario eligió un cliente existente—, y el servicio se queda con el `customerId`: el alta
   * del padrón habría creado igual un cliente que ya nadie va a usar, contado además entre
   * los que la pantalla informa como creados.
   */
  .superRefine((body, ctx) => {
    for (const [i, row] of body.rows.entries()) {
      if (row.customerId === null && row.newCustomer === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', i, 'customerId'],
          message: 'La fila no tiene cliente: elígelo o marca que se cree desde el padrón',
        });
      }
      if (row.customerId !== null && row.newCustomer !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', i, 'newCustomer'],
          message: 'La fila trae cliente elegido y alta desde el padrón a la vez: manda uno solo',
        });
      }
    }
  });
export type ImportQuotationsInput = z.infer<typeof importQuotationsSchema>;

export const quotationImportResultSchema = z.object({
  quotations: z.number().int(),
  rows: z.number().int(),
  /** Los códigos creados, en el orden en que se crearon. */
  codes: z.array(z.string()),
  /**
   * D-158: los clientes que la importación dio de alta desde el padrón, con su nombre real.
   * Se devuelven porque son el efecto de esta operación que **no** se ve en el listado de
   * cotizaciones, y el único momento en que alguien puede revisarlos es justo después.
   */
  createdCustomers: z.array(z.string()),
});
export type QuotationImportResultDto = z.infer<typeof quotationImportResultSchema>;

/**
 * El prefijo con el que el número del comprobante externo viaja a las observaciones de la
 * cotización que crea el importador (D-152).
 *
 * Vive acá y no en el importador desde D-163: dejó de ser un detalle suyo el día que **otro**
 * módulo tuvo que preguntar «¿esta cotización la trajo el importador?». Hoy lo preguntan tres
 * lugares —el importador para avisar de una reimportación, y `QuotationsService` para no
 * aplicarle a un histórico ni el vencimiento ni el piso de precio— y tres literales separados
 * habrían dejado a dos de ellos mudos sin que nadie lo note.
 */
export const EXTERNAL_INVOICE_NOTES_PREFIX = 'Factura externa: ';

/**
 * `true` si esta cotización la creó el importador de comprobantes históricos (D-152).
 *
 * Es una lectura de las observaciones porque así se marcó desde el principio: D-152 eligió a
 * propósito no agregarle una columna al modelo por un dato de procedencia. La contrapartida
 * conocida es que alguien puede tipear ese prefijo a mano en las observaciones de una
 * cotización nueva; el peor caso es que esa cotización se salte el piso de precio, que es una
 * decisión que el mismo usuario podía tomar cambiando el margen mínimo.
 */
export function isImportedQuotation(notes: string | null): boolean {
  return notes?.startsWith(EXTERNAL_INVOICE_NOTES_PREFIX) === true;
}

/**
 * D-169: el número del comprobante externo que originó esta cotización (`F001-1349`), o
 * `null` si no la trajo el importador.
 *
 * Sirve para **nombrar el documento en un error**. Vive acá, pegado al prefijo y a
 * `isImportedQuotation`, porque las tres leen la misma convención: separarlas fue lo que hizo
 * que el importador tuviera tres formas distintas de reconocer su propia marca.
 */
export function externalInvoiceOf(notes: string | null): string | null {
  if (!isImportedQuotation(notes) || notes === null) return null;
  const firstLine = notes.split('\n')[0] ?? '';
  const key = firstLine.slice(EXTERNAL_INVOICE_NOTES_PREFIX.length).trim();
  return key === '' ? null : key;
}

/**
 * D-387: forma de un número de comprobante: serie de cuatro (letra y tres letras o dígitos) y
 * correlativo de hasta ocho dígitos, como lo escribe el papel (`FFA1-1419`, `BBV1-347`).
 */
const IMPORTED_INVOICE_NUMBER = /^([A-Z][A-Z0-9]{3})-(\d{1,8})$/i;

/**
 * cc28 (P2-2 de cc19, D-462): espacios alrededor del guion y en los bordes no cambian el número:
 * la columna del Excel del importador se llama `SERIE - NÚMERO` y una marca `FFA1 - 1419` quedaba
 * vacía, sin buscarse ni ordenarse. Se compacta antes de comparar la forma; nada más se adivina.
 */
export function compactInvoiceNumber(value: string): string {
  return value.trim().replace(/\s*-\s*/g, '-');
}

/**
 * D-387: el número de factura de una cotización importada, para **mostrarlo, buscarlo y
 * ordenar** la lista; `null` si no es importada o si su marca no trae un número con forma de
 * comprobante.
 *
 * Es la única lectura del dato: la columna, el buscador y el orden de la lista pasan por acá. Se
 * apoya en `externalInvoiceOf` (la marca del importador, primera línea de las observaciones,
 * D-152) y además exige la forma `SERIE-NÚMERO`: lo que no calza queda vacío, nunca se adivina.
 * Un número que aparezca más abajo en las observaciones no cuenta: solo la marca.
 */
export function importedInvoiceNumber(notes: string | null): string | null {
  const raw = externalInvoiceOf(notes);
  const key = raw === null ? null : compactInvoiceNumber(raw);
  return key !== null && IMPORTED_INVOICE_NUMBER.test(key) ? key : null;
}

/**
 * D-387: orden ascendente de dos números de `importedInvoiceNumber`: por serie y después por
 * correlativo **como número** (`FFA1-999` antes que `FFA1-1000`), sin distinguir mayúsculas.
 */
export function compareImportedInvoiceNumbers(a: string, b: string): number {
  const [, seriesA = '', numberA = '0'] = IMPORTED_INVOICE_NUMBER.exec(a) ?? [];
  const [, seriesB = '', numberB = '0'] = IMPORTED_INVOICE_NUMBER.exec(b) ?? [];
  const bySeries = seriesA.toUpperCase().localeCompare(seriesB.toUpperCase(), 'en');
  return bySeries === 0 ? Number(numberA) - Number(numberB) : bySeries;
}

/**
 * D-387: un número de comprobante normalizado para **comparar**: serie en mayúsculas y
 * correlativo sin ceros a la izquierda (`FFA1-00001419` y `ffa1-1419` → `FFA1-1419`); `null` si no
 * tiene la forma `SERIE-NÚMERO`. El del sistema guarda el correlativo a ocho dígitos y el del
 * papel no: compararlos como texto los haría distintos siempre.
 */
export function normalizeInvoiceNumber(value: string): string | null {
  const match = IMPORTED_INVOICE_NUMBER.exec(compactInvoiceNumber(value));
  if (match === null) return null;
  const [, series = '', correlative = '0'] = match;
  return `${series.toUpperCase()}-${String(Number(correlative))}`;
}

/** D-387: caracteres significativos mínimos para buscar por comprobante. */
export const INVOICE_SEARCH_MIN_CHARS = 3;

/**
 * D-387: lo que el buscador compara contra los números de comprobante, ya normalizado: un número
 * entero (`FFA1-0001419` → `FFA1-1419`), solo dígitos sin los ceros de adelante (`001419` →
 * `1419`) o el texto en mayúsculas (`ffa1-` → `FFA1-`). `null` con menos de
 * `INVOICE_SEARCH_MIN_CHARS`: buscar «0» o «1» coincidiría con todos los comprobantes.
 */
export function invoiceSearchNeedle(search: string): string | null {
  const raw = compactInvoiceNumber(search).toUpperCase();
  const needle = normalizeInvoiceNumber(raw) ?? (/^\d+$/.test(raw) ? raw.replace(/^0+/, '') : raw);
  return needle.length >= INVOICE_SEARCH_MIN_CHARS ? needle : null;
}

/**
 * D-387: si el buscador de la lista encuentra este número de comprobante. Se comparan las formas
 * normalizadas: `FFA1-1419` encuentra a `FFA1-00001419`, y los ceros de relleno del correlativo
 * del sistema no hacen que «000» coincida con todos.
 */
export function invoiceNumberContains(value: string | null, search: string): boolean {
  const needle = invoiceSearchNeedle(search);
  if (value === null || needle === null) return false;
  return (normalizeInvoiceNumber(value) ?? value.trim().toUpperCase()).includes(needle);
}

/** D-387: un comprobante vigente (factura o boleta) del pedido de la cotización. */
export interface QuotationInvoiceDocument {
  id: string;
  number: string;
}

/**
 * D-387: qué dice la columna «Comprobante» de una cotización, calculado al leer:
 *
 * - `REFERENCE`: hay número en la marca del importador y ningún comprobante vigente en el sistema;
 * - `REGISTERED`: el pedido tiene comprobante vigente y, si hay número en la marca, alguno coincide
 *   con él (vale también para una cotización no importada);
 * - `MISMATCH`: hay comprobante vigente y ninguno coincide con el número de la marca;
 * - `NONE`: ni una cosa ni la otra.
 */
export type QuotationInvoiceState =
  | { kind: 'NONE' }
  | { kind: 'REFERENCE'; reference: string }
  | { kind: 'REGISTERED'; reference: string | null; documents: QuotationInvoiceDocument[] }
  | { kind: 'MISMATCH'; reference: string; documents: QuotationInvoiceDocument[] };

/**
 * D-387: el estado de la columna «Comprobante». `reference` es `importedInvoiceNumber` de la
 * cotización; `documents`, los comprobantes vigentes de su pedido, el primero el que se muestra.
 * La coincidencia se mide con `normalizeInvoiceNumber`, la misma lectura para los dos lados.
 */
export function quotationInvoiceState(
  reference: string | null,
  documents: readonly QuotationInvoiceDocument[],
): QuotationInvoiceState {
  if (documents.length === 0) {
    return reference === null ? { kind: 'NONE' } : { kind: 'REFERENCE', reference };
  }
  const docs = [...documents];
  if (reference === null) return { kind: 'REGISTERED', reference: null, documents: docs };
  const wanted = normalizeInvoiceNumber(reference);
  const matches = docs.some((d) => wanted !== null && normalizeInvoiceNumber(d.number) === wanted);
  return matches
    ? { kind: 'REGISTERED', reference, documents: docs }
    : { kind: 'MISMATCH', reference, documents: docs };
}

/**
 * D-387: el número que la columna muestra —el primer comprobante vigente o, sin él, el de la
 * marca—, que es también el que ordena la lista. `null` en `NONE`.
 */
export function shownInvoiceNumber(state: QuotationInvoiceState): string | null {
  switch (state.kind) {
    case 'NONE':
      return null;
    case 'REFERENCE':
      return state.reference;
    default:
      return state.documents[0]?.number ?? null;
  }
}

/**
 * D-256 (3), repaso de RF-S4b: las observaciones **sin** la marca de procedencia. El duplicado
 * de una cotización importada es una cotización viva de hoy (D-157), no el comprobante: sin
 * esto nacía con la marca, quedaba exenta al editarla y el barrido la tomaba como un segundo
 * documento del mismo comprobante.
 */
export function stripImportMarker(notes: string | null): string | null {
  if (!isImportedQuotation(notes) || notes === null) return notes;
  const rest = notes.split('\n').slice(1).join('\n').trim();
  return rest === '' ? null : rest;
}

/** Tope de `quotations.notes` (`VarChar(500)`). El texto del usuario se recorta, la marca no. */
const NOTES_MAX = 500;

/**
 * Las observaciones que quedan al editar una cotización, **conservando la marca de
 * procedencia** si la tenía (D-152/D-163).
 *
 * La marca no es una observación que alguien escribió: es de dónde salió el documento. Y de
 * ella dependen dos cosas —que el importador avise de una reimportación y que el piso de
 * precio no se le aplique a un histórico— así que una edición que no reenvíe las
 * observaciones no la puede borrar. Sin esto, editar una cotización importada la dejaba sin
 * marca, y el **segundo** `PUT` con el mismo precio histórico rebotaba contra el piso: un
 * documento que se vuelve inválido por haberlo guardado dos veces.
 *
 * Si el texto nuevo ya trae la marca se respeta tal cual; si no, la marca va primero y el
 * texto del usuario debajo. Lo que se recorta al tope de la columna es el texto, nunca la
 * marca — al revés, perderla es justamente el defecto que esta función existe para evitar.
 */
export function keepImportMarker(
  currentNotes: string | null,
  newNotes: string | null,
): string | null {
  if (!isImportedQuotation(currentNotes) || currentNotes === null) return newNotes;
  const marker = currentNotes.split('\n')[0] ?? '';
  if (newNotes === null || newNotes.trim() === '') return marker;
  if (newNotes.startsWith(marker)) return newNotes.slice(0, NOTES_MAX);
  return `${marker}\n${newNotes}`.slice(0, NOTES_MAX);
}
