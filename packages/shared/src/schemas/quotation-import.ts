import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE, toDecimal, type Decimal } from '../decimal';
import {
  MAX_PIECE_LENGTH_MM,
  MIN_PIECE_LENGTH_MM,
  roofingPiecesSchema,
  type PieceLike,
} from './roofing';

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
};

/** Tope de filas de un archivo. Una carga mensual real ronda las 150. */
export const MAX_QUOTATION_IMPORT_ROWS = 1_000;

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
  field: z.enum(['customer', 'product', 'qty', 'unitPrice', 'pieces', 'row']),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
});
export type QuotationImportIssueDto = z.infer<typeof quotationImportIssueSchema>;

/**
 * Lo que el navegador manda de vuelta al confirmar: la fila **ya resuelta y editada**. El
 * texto crudo del Excel no vuelve — lo que decide qué se crea es el id del cliente, el del
 * producto y los números, no el nombre que traía el papel.
 */
export const quotationImportRowInputSchema = z.object({
  /** Fila del Excel (1-based sobre los datos, sin contar el encabezado). Solo para el reporte. */
  rowNumber: z.number().int().positive(),
  /** `FFA1-1349`: agrupa las líneas de una misma cotización y viaja a las observaciones. */
  documentKey: z.string().trim().min(1).max(60),
  /** D-124: día de negocio de la cotización, tomado de `F. EMISIÓN`. */
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en formato YYYY-MM-DD'),
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  qty: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }),
  /** Precio unitario **sin IGV y en soles**, ya convertido si el documento venía en dólares. */
  unitPricePen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }),
  description: z.string().trim().max(240).optional(),
  /** D-083: los largos de una cobertura a medida. Ausente en toda línea simple. */
  pieces: roofingPiecesSchema.optional(),
});
export type QuotationImportRowInput = z.infer<typeof quotationImportRowInputSchema>;

/** Una fila del preview: lo de arriba más lo que hace falta para pintarla y decidirla. */
export const quotationImportRowSchema = quotationImportRowInputSchema
  .extend({
    customerId: z.string().uuid().nullable(),
    productId: z.string().uuid().nullable(),
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
  .omit({ qty: true, unitPricePen: true })
  .extend({
    qty: z.string(),
    unitPricePen: z.string(),
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
export const importQuotationsSchema = z.object({
  rows: z
    .array(quotationImportRowInputSchema)
    .min(1, 'No hay ninguna fila para importar')
    .max(MAX_QUOTATION_IMPORT_ROWS, `Máximo ${MAX_QUOTATION_IMPORT_ROWS} filas por archivo`),
});
export type ImportQuotationsInput = z.infer<typeof importQuotationsSchema>;

export const quotationImportResultSchema = z.object({
  quotations: z.number().int(),
  rows: z.number().int(),
  /** Los códigos creados, en el orden en que se crearon. */
  codes: z.array(z.string()),
});
export type QuotationImportResultDto = z.infer<typeof quotationImportResultSchema>;
