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
  /** Precio unitario **sin IGV y en soles**, ya convertido si el documento venía en dólares. */
  unitPricePen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }),
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
   * importe se recalcula desde lo que esa persona tipeó. Mandarlo igual habría hecho que
   * corregir un precio no cambiara el importe —y el rechazo por tolerancia habría culpado al
   * archivo de una diferencia que introdujo la corrección.
   */
  netAmountPen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }).optional(),
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
  .omit({ qty: true, unitPricePen: true, netAmountPen: true })
  .extend({
    qty: z.string(),
    unitPricePen: z.string(),
    netAmountPen: z.string(),
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
