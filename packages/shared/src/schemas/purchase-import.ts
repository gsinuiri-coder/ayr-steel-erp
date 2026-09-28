import { z } from 'zod';
import {
  type BUSINESS_LINES,
  type CURRENCIES,
  type PAYMENT_TERMS,
  type PURCHASE_TYPES,
  type SERVICE_KINDS,
} from '../enums';
import { toDecimal } from '../decimal';
import { idempotencyFields } from './idempotency';
import { supplierCodeSchema } from './supplier';

/**
 * **Importador de compras (D-351).** Mismo esquema que el de cotizaciones (D-152): dos pasos
 * sin estado en medio —preview y confirmación—, todo lo que crea pasa por el alta normal
 * (`PurchasesService.createInTx`) y se detiene en BORRADOR. Una fila de la planilla es una línea;
 * las filas se agrupan en comprobantes por proveedor + tipo + serie-número.
 */

/** Columnas de la plantilla (`docs/plantillas/importar-compras.xlsx`). */
export const PURCHASE_IMPORT_COLUMNS = {
  type: { key: 'type', header: 'TIPO DE COMPRA', required: true },
  businessLine: { key: 'businessLine', header: 'LÍNEA DE NEGOCIO', required: true },
  docType: { key: 'docType', header: 'TIPO DE COMPROBANTE', required: true },
  document: { key: 'document', header: 'SERIE-NÚMERO', required: true },
  issueDate: { key: 'issueDate', header: 'FECHA DE EMISIÓN', required: true },
  supplierRuc: { key: 'supplierRuc', header: 'RUC PROVEEDOR', required: true },
  currency: { key: 'currency', header: 'MONEDA', required: true },
  exchangeRate: { key: 'exchangeRate', header: 'TIPO DE CAMBIO', required: false },
  paymentTerms: { key: 'paymentTerms', header: 'CONDICIÓN DE PAGO', required: true },
  creditDays: { key: 'creditDays', header: 'DÍAS DE CRÉDITO', required: false },
  serviceKind: { key: 'serviceKind', header: 'TIPO DE SERVICIO', required: false },
  igvRate: { key: 'igvRate', header: 'TASA IGV', required: false },
  notes: { key: 'notes', header: 'OBSERVACIONES', required: false },
  // D-359: el total del papel es **con IGV** y el encabezado lo dice; el de la primera
  // plantilla sigue aceptado para no invalidar los archivos ya llenados.
  documentTotal: {
    key: 'documentTotal',
    header: 'TOTAL COMPROBANTE CON IGV',
    aliases: ['TOTAL COMPROBANTE'],
    required: false,
  },
  sku: { key: 'sku', header: 'SKU', required: false },
  description: { key: 'description', header: 'DESCRIPCIÓN', required: false },
  qty: { key: 'qty', header: 'CANTIDAD', required: false },
  unit: { key: 'unit', header: 'UNIDAD', required: false },
  unitPrice: { key: 'unitPrice', header: 'PRECIO UNITARIO SIN IGV', required: true },
  // El importe de la línea sin IGV del papel: si viene, manda sobre el precio unitario.
  lineAmount: { key: 'lineAmount', header: 'IMPORTE SIN IGV', required: false },
  finishCode: { key: 'finishCode', header: 'CÓDIGO DE ACABADO', required: false },
  color: { key: 'color', header: 'COLOR', required: false },
  thicknessMm: { key: 'thicknessMm', header: 'ESPESOR MM', required: false },
  widthMm: { key: 'widthMm', header: 'ANCHO MM', required: false },
  kg: { key: 'kg', header: 'KG', required: false },
  externalCode: { key: 'externalCode', header: 'CÓDIGO EXTERNO', required: false },
} as const;

/** Tope de filas por archivo: el de una carga mensual, no el de un formulario. */
export const MAX_PURCHASE_IMPORT_ROWS = 1000;

/** Líneas de un comprobante: el mismo tope que el alta (`createPurchaseSchema`). */
export const MAX_PURCHASE_IMPORT_LINES = 200;

// --------------------------------------------------------------------------
// Lo que el navegador manda: el comprobante revisado
// --------------------------------------------------------------------------

/**
 * Una línea tal como quedó después de revisar el preview. Los textos del archivo viajan tal
 * cual (el servidor los valida de nuevo); lo que el usuario eligió en pantalla viaja como id.
 */
export const purchaseImportLineInputSchema = z.object({
  /** Fila de la planilla, para que el error diga dónde mirar. 0 = agregada en pantalla. */
  rowNumber: z.number().int().min(0),
  sku: z.string().trim().max(60).default(''),
  /** El producto elegido en pantalla (D-156); gana sobre el SKU. */
  productId: z.string().uuid().nullable().default(null),
  description: z.string().trim().max(240).default(''),
  qty: z.string().trim().max(40).default(''),
  unit: z.string().trim().max(20).default(''),
  unitPrice: z.string().trim().max(40).default(''),
  /** Importe de la línea sin IGV del papel; vacío = se calcula de cantidad × precio. */
  lineAmount: z.string().trim().max(40).default(''),
  finishCode: z.string().trim().max(60).default(''),
  /** El acabado elegido en pantalla (sin alta: D-203 lo exige completo). */
  finishId: z.string().uuid().nullable().default(null),
  color: z.string().trim().max(60).default(''),
  thicknessMm: z.string().trim().max(40).default(''),
  widthMm: z.string().trim().max(40).default(''),
  externalCode: z.string().trim().max(40).default(''),
});
export type PurchaseImportLineInput = z.infer<typeof purchaseImportLineInputSchema>;

export const purchaseImportDocumentInputSchema = z.object({
  /** Clave estable del comprobante en el archivo (RUC|tipo|serie-número). */
  key: z.string().trim().min(1).max(120),
  type: z.string().trim().max(40),
  businessLine: z.string().trim().max(40),
  docType: z.string().trim().max(40),
  series: z.string().trim().max(20),
  number: z.string().trim().max(30),
  issueDate: z.string().trim().max(20),
  supplierRuc: z.string().trim().max(20),
  /** El proveedor elegido en pantalla; `null` = el del RUC, o alta desde el padrón. */
  supplierId: z.string().uuid().nullable().default(null),
  /**
   * D-351 (decisión del dueño): el código corto del proveedor nuevo que se crea desde el
   * padrón. Lo sugiere el preview y se puede cambiar; el nombre **no** viaja (lo pone el padrón).
   */
  newSupplierCode: z.string().trim().max(10).nullable().default(null),
  currency: z.string().trim().max(10),
  exchangeRate: z.string().trim().max(20).default(''),
  paymentTerms: z.string().trim().max(20),
  creditDays: z.string().trim().max(10).default(''),
  serviceKind: z.string().trim().max(40).default(''),
  igvRate: z.string().trim().max(10).default(''),
  notes: z.string().trim().max(500).default(''),
  documentTotal: z.string().trim().max(40).default(''),
  /**
   * D-352: el comprobante coincide con una factura de referencia de la carga inicial y el usuario
   * marcó «Es otra compra». Sin la marca, ese comprobante no se confirma.
   */
  confirmedNotInitialLoad: z.boolean().default(false),
  lines: z.array(purchaseImportLineInputSchema).min(1, 'El comprobante no tiene líneas'),
});
export type PurchaseImportDocumentInput = z.infer<typeof purchaseImportDocumentInputSchema>;

export const validatePurchaseImportSchema = z.object({
  documents: z
    .array(purchaseImportDocumentInputSchema)
    .min(1, 'No hay comprobantes')
    .max(MAX_PURCHASE_IMPORT_ROWS),
});
export type ValidatePurchaseImportInput = z.infer<typeof validatePurchaseImportSchema>;

export const confirmPurchaseImportSchema = validatePurchaseImportSchema.extend({
  fileName: z.string().trim().max(200).default(''),
  ...idempotencyFields,
});
export type ConfirmPurchaseImportInput = z.infer<typeof confirmPurchaseImportSchema>;

// --------------------------------------------------------------------------
// Lo que el servidor devuelve
// --------------------------------------------------------------------------

export const PURCHASE_IMPORT_ISSUE_SEVERITIES = ['error', 'warning'] as const;

export const purchaseImportIssueSchema = z.object({
  severity: z.enum(PURCHASE_IMPORT_ISSUE_SEVERITIES),
  /** Campo del comprobante (`supplier`, `issueDate`…) o `lines.<i>.<campo>`. */
  field: z.string(),
  message: z.string(),
});
export type PurchaseImportIssueDto = z.infer<typeof purchaseImportIssueSchema>;

export const purchaseImportLineSchema = purchaseImportLineInputSchema.extend({
  /** Lo resuelto: el producto por SKU o elegido, el acabado por código o elegido. */
  productId: z.string().uuid().nullable(),
  productLabel: z.string().nullable(),
  finishId: z.string().uuid().nullable(),
  finishLabel: z.string().nullable(),
  /** Importes recalculados con `Decimal` (en la moneda del comprobante), o `null` si no se pudo. */
  subtotal: z.string().nullable(),
  issues: z.array(purchaseImportIssueSchema),
});
export type PurchaseImportLineDto = z.infer<typeof purchaseImportLineSchema>;

export const purchaseImportDocumentSchema = purchaseImportDocumentInputSchema.extend({
  lines: z.array(purchaseImportLineSchema),
  supplierId: z.string().uuid().nullable(),
  supplierLabel: z.string().nullable(),
  /** D-158/D-351: el padrón conoce el RUC y el maestro no; se crea al confirmar. */
  newSupplier: z.object({ name: z.string(), suggestedCode: z.string() }).nullable(),
  /** El TC con el que se registraría (manual, 1 en soles o el SUNAT del día de emisión). */
  resolvedExchangeRate: z.object({ rate: z.string(), source: z.string() }).nullable(),
  subtotal: z.string().nullable(),
  igv: z.string().nullable(),
  total: z.string().nullable(),
  /** D-352: la factura de referencia de la carga inicial con la que coincide. */
  initialLoadMatch: z.object({ reference: z.string(), items: z.array(z.string()) }).nullable(),
  issues: z.array(purchaseImportIssueSchema),
});
export type PurchaseImportDocumentDto = z.infer<typeof purchaseImportDocumentSchema>;

export const purchaseImportPreviewSchema = z.object({
  fileName: z.string(),
  rows: z.number().int(),
  documents: z.array(purchaseImportDocumentSchema),
  /** Avisos del archivo entero (columnas desconocidas, tope del padrón…). */
  notices: z.array(z.string()),
});
export type PurchaseImportPreviewDto = z.infer<typeof purchaseImportPreviewSchema>;

export const purchaseImportResultSchema = z.object({
  batchId: z.string().uuid(),
  purchases: z.array(
    z.object({ id: z.string().uuid(), document: z.string(), supplier: z.string() }),
  ),
  createdSuppliers: z.array(z.string()),
});
export type PurchaseImportResultDto = z.infer<typeof purchaseImportResultSchema>;

export const purchaseImportUndoResultSchema = z.object({
  batchId: z.string().uuid(),
  cancelled: z.array(z.string()),
  kept: z.array(z.object({ document: z.string(), reason: z.string() })),
});
export type PurchaseImportUndoResultDto = z.infer<typeof purchaseImportUndoResultSchema>;

// --------------------------------------------------------------------------
// Lectores puros (compartidos por el API y la vista)
// --------------------------------------------------------------------------

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

const TYPE_ALIASES: Record<string, (typeof PURCHASE_TYPES)[number]> = {
  COIL: 'COIL',
  BOBINA: 'COIL',
  BOBINAS: 'COIL',
  FINISHED_GOOD: 'FINISHED_GOOD',
  'PRODUCTO TERMINADO': 'FINISHED_GOOD',
  PRODUCTO: 'FINISHED_GOOD',
  SERVICE: 'SERVICE',
  SERVICIO: 'SERVICE',
  EXPENSE: 'EXPENSE',
  GASTO: 'EXPENSE',
};

/** `Bobinas`, `bobina`, `COIL` → `COIL`. `null` si no es un tipo de compra. */
export function purchaseTypeOf(raw: string): (typeof PURCHASE_TYPES)[number] | null {
  return TYPE_ALIASES[fold(raw)] ?? null;
}

const LINE_ALIASES: Record<string, (typeof BUSINESS_LINES)[number]> = {
  DRYWALL: 'drywall',
  'METALLIC-ROOFING': 'metallic-roofing',
  'COBERTURAS ALUZINC': 'metallic-roofing',
  ALUZINC: 'metallic-roofing',
  ROOFING: 'roofing',
  'COBERTURAS (UPVC)': 'roofing',
  'COBERTURAS UPVC': 'roofing',
  UPVC: 'roofing',
  TRADING: 'trading',
  REVENTA: 'trading',
  SERVICES: 'services',
  SERVICIOS: 'services',
};

/** Código o nombre de la línea de negocio → código compartido. */
export function businessLineOf(raw: string): (typeof BUSINESS_LINES)[number] | null {
  return LINE_ALIASES[fold(raw)] ?? null;
}

/** Solo factura y boleta: una nota de crédito o débito necesita el comprobante que ajusta. */
export function purchaseDocTypeOf(raw: string): 'FACTURA' | 'BOLETA' | null {
  const v = fold(raw);
  if (v === 'FACTURA' || v === '01') return 'FACTURA';
  if (v === 'BOLETA' || v === 'BOLETA DE VENTA' || v === '03') return 'BOLETA';
  return null;
}

export function currencyOf(raw: string): (typeof CURRENCIES)[number] | null {
  const v = fold(raw);
  if (v === 'PEN' || v === 'SOLES' || v === 'S/' || v === 'S/.') return 'PEN';
  if (v === 'USD' || v === 'DOLARES' || v === 'US$' || v === '$') return 'USD';
  return null;
}

export function paymentTermsOf(raw: string): (typeof PAYMENT_TERMS)[number] | null {
  const v = fold(raw);
  if (v === 'CONTADO') return 'CONTADO';
  if (v === 'CREDITO') return 'CREDITO';
  return null;
}

const SERVICE_ALIASES: Record<string, (typeof SERVICE_KINDS)[number]> = {
  CUTTING: 'CUTTING',
  CORTE: 'CUTTING',
  'CORTE TERCERIZADO': 'CUTTING',
  FREIGHT: 'FREIGHT',
  FLETE: 'FREIGHT',
  CUSTOMS: 'CUSTOMS',
  ADUANA: 'CUSTOMS',
  ADUANAS: 'CUSTOMS',
  INSURANCE: 'INSURANCE',
  SEGURO: 'INSURANCE',
  OTHER: 'OTHER',
  OTRO: 'OTHER',
  'OTRO SERVICIO': 'OTHER',
};

export function serviceKindOf(raw: string): (typeof SERVICE_KINDS)[number] | null {
  return SERVICE_ALIASES[fold(raw)] ?? null;
}

/**
 * Un número tipeado por un humano en una planilla peruana: `1.234,56`, `1,234.56`, `1234,56`,
 * `1234.56`, `1.234.567` o `1,234,567` → sin separadores de miles y con punto decimal. `null` si
 * no es un número. Solo normaliza la forma; el rango lo valida quien lo usa.
 *
 * - Con los dos separadores, el último es el decimal y el otro es de miles (en grupos de tres).
 * - Un separador **repetido** (`1.234.567`) solo puede ser de miles: exige grupos de tres.
 * - **Una sola coma es decimal**: `3,745` es el tipo de cambio de la plantilla y `0,980` un precio;
 *   leerla como miles cambiaría de valor un dato que la plantilla ya pide así (D-359).
 */
export function normalizeDecimal(raw: string): string | null {
  let v = raw.trim().replace(/\s/g, '');
  if (v === '') return null;
  if (v.includes(',') && v.includes('.')) {
    const decimalIsComma = v.lastIndexOf(',') > v.lastIndexOf('.');
    const decimal = decimalIsComma ? ',' : '.';
    const thousands = decimalIsComma ? '.' : ',';
    const parts = v.split(decimal);
    if (parts.length !== 2 || !thousandsGrouped(parts[0] ?? '', thousands)) return null;
    v = `${(parts[0] ?? '').split(thousands).join('')}.${parts[1] ?? ''}`;
  } else {
    const sep = v.includes(',') ? ',' : v.includes('.') ? '.' : null;
    if (sep !== null && v.split(sep).length > 2) {
      if (!thousandsGrouped(v, sep)) return null;
      v = v.split(sep).join('');
    } else if (sep === ',') {
      v = v.replace(',', '.');
    }
  }
  return /^\d+(\.\d+)?$/.test(v) ? v : null;
}

/** `1.234.567` con `.`: el primer grupo de 1 a 3 dígitos y los demás de exactamente 3. */
function thousandsGrouped(intPart: string, sep: string): boolean {
  if (!intPart.includes(sep)) return /^\d+$/.test(intPart);
  const [head = '', ...rest] = intPart.split(sep);
  return /^\d{1,3}$/.test(head) && rest.every((g) => /^\d{3}$/.test(g));
}

/**
 * D-359: la tasa de IGV como la escribe una persona o la guarda Excel. `18`, `18%` y `0.18` son la
 * misma tasa: una celda con formato de porcentaje guarda `0,18`, y se leía como 0,18 %, lo que
 * dejaba el IGV en céntimos y el total del papel «descuadrado» en todos los comprobantes. Un valor
 * mayor que 0 y menor que 1 **sin** el signo % es una fracción; `0` sigue siendo 0 (exonerado). Devuelve la tasa en
 * puntos porcentuales, o `null` si no es un número.
 */
export function normalizeIgvRate(raw: string): string | null {
  const trimmed = raw.trim();
  // Con el signo escrito, el número ya está en puntos: `0.18%` es 0,18 % y no se reinterpreta.
  const percentSign = trimmed.endsWith('%');
  const text = normalizeDecimal(trimmed.replace(/%$/, ''));
  if (text === null) return null;
  const rate = toDecimal(text);
  return (!percentSign && rate.gt(0) && rate.lt(1) ? rate.times(100) : rate).toFixed();
}

/** `F001-00012345` → `{ series: 'F001', number: '00012345' }`. */
export function splitDocumentNumber(raw: string): { series: string; number: string } | null {
  const v = raw.trim().toUpperCase().replace(/\s/g, '');
  const match = /^([A-Z0-9]{1,10})-(\d{1,20})$/.exec(v);
  if (!match?.[1] || !match[2]) return null;
  return { series: match[1], number: match[2] };
}

/**
 * D-352: la forma comparable de un comprobante, la misma para la compra y para la «factura de
 * referencia» de la carga inicial (texto libre, D-206): mayúsculas, sin espacios, y el número
 * sin ceros a la izquierda. `F001-00013071`, `f001 - 13071` y `F001-13071` son el mismo papel.
 */
export function comparableDocument(raw: string): string {
  const v = raw.toUpperCase().replace(/\s/g, '');
  const dash = v.lastIndexOf('-');
  if (dash <= 0) return v.replace(/^0+(?=\d)/, '');
  const series = v.slice(0, dash);
  const number = v.slice(dash + 1).replace(/^0+(?=\d)/, '');
  return `${series}-${number}`;
}

const LEGAL_FORM_WORDS = new Set([
  'SAC',
  'SA',
  'SRL',
  'EIRL',
  'SAA',
  'SCRL',
  'SOCIEDAD',
  'ANONIMA',
  'CERRADA',
  'EMPRESA',
  'INDIVIDUAL',
  'DE',
  'DEL',
  'LA',
  'LAS',
  'LOS',
  'Y',
  'E',
]);

/**
 * D-351 (decisión del dueño): el código corto sugerido para un proveedor nuevo que se crea desde
 * el padrón — tres letras sacadas de la razón social (las iniciales, o el principio de la primera
 * palabra), que no choquen con `taken`. Si todas las variantes de tres letras chocan, prueba con
 * cuatro. Se muestra en el preview y el usuario lo puede cambiar antes de confirmar.
 */
export function suggestSupplierCode(name: string, taken: ReadonlySet<string>): string {
  const words = fold(name)
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !LEGAL_FORM_WORDS.has(w));
  const letters = words.join('');
  const initials = words.map((w) => w[0]).join('');
  const candidates: string[] = [];
  if (initials.length >= 3) candidates.push(initials.slice(0, 3));
  if (letters.length >= 3) candidates.push(letters.slice(0, 3));
  if (initials.length >= 1 && letters.length >= 1) {
    for (const c of letters)
      candidates.push(`${initials.slice(0, 2).padEnd(2, c)}${c}`.slice(0, 3));
  }
  for (const code of candidates) {
    if (/^[A-Z]{3}$/.test(code) && !taken.has(code)) return code;
  }
  const base = (letters + 'XXX').slice(0, 3);
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!taken.has(`${base}${c}`)) return `${base}${c}`;
  }
  return base;
}

/** El código de un proveedor nuevo: las mismas reglas que el alta. */
export const newSupplierCodeSchema = supplierCodeSchema;

/** Deshacer un lote (D-351): anula compras, así que pide su motivo, como toda anulación. */
export const undoPurchaseImportSchema = z.object({
  reason: z
    .string({ required_error: 'El motivo es obligatorio' })
    .trim()
    .min(3, 'Explica el motivo en al menos 3 caracteres')
    .max(180, 'Máximo 180 caracteres'),
});
export type UndoPurchaseImportInput = z.infer<typeof undoPurchaseImportSchema>;
