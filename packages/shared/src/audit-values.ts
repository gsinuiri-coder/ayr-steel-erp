import {
  BUSINESS_LINE_LABELS,
  COIL_FILM_LABELS,
  COIL_SPLIT_STATUS_LABELS,
  COIL_STATUS_LABELS,
  CREDIT_NOTE_REASON_LABELS,
  CURRENCY_LABELS,
  CUTTING_ORDER_COIL_STATUS_LABELS,
  CUTTING_ORDER_STATUS_LABELS,
  DISPATCH_STATUS_LABELS,
  DOC_TYPE_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  FISCAL_DOCUMENT_ORIGIN_LABELS,
  FISCAL_DOCUMENT_STATUS_LABELS,
  INVENTORY_ITEM_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_TERMS_LABELS,
  PRODUCT_BOM_KIND_LABELS,
  PRODUCT_SOURCE_LABELS,
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_REPORT_STATUS_LABELS,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_STATUS_LABELS,
  PURCHASE_TYPE_LABELS,
  QUOTATION_STATUS_LABELS,
  RESERVATION_STATUS_LABELS,
  ROLE_LABELS,
  ROOFING_PRODUCT_KIND_LABELS,
  SALES_ORDER_STATUS_LABELS,
  SERVICE_KIND_LABELS,
  TEMPORARY_RESERVATION_STATUS_LABELS,
  UNIT_LABELS,
} from './enums';
import { FINISH_KIND_LABELS } from './schemas/finish';
import { CASH_SESSION_STATUS_LABELS, POS_SALE_STATUS_LABELS } from './schemas/pos';
import { DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS } from './schemas/production';
import { TOLERANCE_OVERRIDE_REASON_LABELS } from './schemas/roofing';
import { AT_COST_REASON_LABELS } from './schemas/sales';

/**
 * cc51 (D-640): los valores de la auditoría que el código guarda como código en inglés (estados,
 * medios de pago, monedas, tipos…) se muestran en castellano, en pantalla y en el Excel. Los
 * registros no cambian: solo cómo se leen. Se reutilizan los rótulos que la app ya usa en sus
 * pantallas; los que no tenían, se escriben acá.
 *
 * Una misma clave puede traer enums distintos según la acción (`status` es el de una bobina, una
 * compra o una OP), así que esas claves se resuelven por el prefijo de la acción. Un valor sin
 * traducción conocida sale tal cual: el texto libre (motivos, documentos) nunca se toca.
 */
type ValueLabels = Readonly<Record<string, string>>;

const YES_NO = { true: 'Sí', false: 'No' } as const;

const AUTO_TERMINATE_KIND_LABELS: ValueLabels = {
  PRODUCTION_ORDER_CLOSE: 'Cierre de OP',
  PRODUCTION_ORDER_CANCEL: 'Anulación de OP',
  COIL_RELEASE: 'Bobina liberada de la OP',
  SCRAP: 'Merma',
  DISPATCH: 'Despacho',
  DISPATCH_MISSING: 'Salida faltante de un despacho',
  SPLIT: 'Partido',
  CUTTING_RECEPTION: 'Recepción de corte tercerizado',
  BATCH: 'Terminación en lote',
};
const COIL_CLOSE_ADJUSTMENT_KIND_LABELS: ValueLabels = {
  SHORTAGE: 'Faltante',
  SURPLUS: 'Sobrante',
};
const AUTO_TERMINATE_SKIP_LABELS: ValueLabels = {
  MOUNTED: 'Montada en una OP',
  RESERVED: 'Con reserva viva (anomalía)',
  NEGATIVE: 'Saldo negativo (anomalía)',
};
const AUTO_REOPEN_SKIP_LABELS: ValueLabels = {
  NOT_CLOSED: 'No estaba terminada',
  OTHER_CAUSE: 'Terminada por otra causa',
};
const PSE_OUTCOME_LABELS: ValueLabels = {
  ACCEPTED: 'Aceptado',
  REJECTED: 'Rechazado',
  ERROR: 'Error de envío',
  PENDING: 'Pendiente',
};
const PRICE_FORM_LABELS: ValueLabels = {
  IMPORTE_DE_LINEA: 'Importe de la línea',
  PRECIO_CON_IGV: 'Precio con IGV',
  VALOR_POR_METRO: 'Valor por metro',
  VALOR_UNITARIO: 'Valor unitario',
};
const POS_FISCAL_PATH_LABELS: ValueLabels = {
  VOID: 'Baja del comprobante',
  CREDIT_NOTE: 'Nota de crédito',
  NONE: 'Sin comprobante',
  DONE: 'Ya estaba deshecho',
};
const COIL_RESTORE_MODE_LABELS: ValueLabels = {
  EN_SU_FECHA: 'En su fecha',
  A_HOY: 'A hoy',
  BLOQUEADA: 'No se puede restaurar',
};
/** Los caminos de «Editar compra recibida» (D-372), como los dice su diálogo. */
const RECEIVED_EDIT_PATH_LABELS: ValueLabels = {
  IN_PLACE: 'Se edita',
  REVERSE_REENTRY: 'Reversa y nuevo ingreso',
  COST_ADJUST: 'Ajuste sobre lo que queda',
  BLOCKED: 'Bloqueado',
};
/** Las líneas de «Despachar a la fecha de emisión» y las OP que sigue un cambio de cantidad. */
const LINE_ACTION_LABELS: ValueLabels = {
  DISPATCH: 'Sale del almacén',
  BEFORE_OPENING: 'Entregada antes del inventario inicial (sin salida)',
  REVIEW: 'No se despacha',
  PLAN: 'Cambio de plan',
  CREATED: 'OP nueva',
};
/** `origin`: el del precio de lista (D-217) y el del comprobante; no comparten códigos. */
const ORIGIN_LABELS: ValueLabels = {
  INLINE: 'Edición en catálogo',
  IMPORT: 'Carga masiva',
  ...FISCAL_DOCUMENT_ORIGIN_LABELS,
};

/** `status` según la acción, del prefijo más específico al más general. */
const STATUS_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['coils.split-revert', COIL_SPLIT_STATUS_LABELS],
  ['coils.', COIL_STATUS_LABELS],
  ['cutting.cancel', CUTTING_ORDER_STATUS_LABELS],
  ['cutting.', CUTTING_ORDER_COIL_STATUS_LABELS],
  ['purchases.', PURCHASE_STATUS_LABELS],
  ['production.report-reverse', PRODUCTION_REPORT_STATUS_LABELS],
  ['production.roofing.report-reverse', PRODUCTION_REPORT_STATUS_LABELS],
  ['production.', PRODUCTION_ORDER_STATUS_LABELS],
  ['sales.quotation.recalculate-temporary', TEMPORARY_RESERVATION_STATUS_LABELS],
  ['sales.quotation.', QUOTATION_STATUS_LABELS],
  ['sales.reservation.', RESERVATION_STATUS_LABELS],
  ['sales.order.', SALES_ORDER_STATUS_LABELS],
  ['invoicing.dispatch.', DISPATCH_STATUS_LABELS],
  ['invoicing.', FISCAL_DOCUMENT_STATUS_LABELS],
  ['pos.cash-session.', CASH_SESSION_STATUS_LABELS],
  ['pos.sale.', POS_SALE_STATUS_LABELS],
];

/** `reason` es texto libre salvo en estas acciones, que guardan un código. */
const REASON_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['coils.auto-terminate-skipped', AUTO_TERMINATE_SKIP_LABELS],
  ['coils.auto-reopen-skipped', AUTO_REOPEN_SKIP_LABELS],
  ['invoicing.credit-note.', CREDIT_NOTE_REASON_LABELS],
  ['production.roofing.report-tolerance-override', TOLERANCE_OVERRIDE_REASON_LABELS],
  ['production.drywall.report-tolerance-override', DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS],
];

const KIND_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['finishes.', FINISH_KIND_LABELS],
  ['production.bom.', PRODUCT_BOM_KIND_LABELS],
  ['production.', PRODUCTION_ORDER_KIND_LABELS],
];

const DOC_TYPE_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['customers.', DOC_TYPE_LABELS],
  ['suppliers.', DOC_TYPE_LABELS],
  ['invoicing.', FISCAL_DOC_TYPE_LABELS],
  ['pos.', FISCAL_DOC_TYPE_LABELS],
  ['purchases.', PURCHASE_DOC_TYPE_LABELS],
];

const SOURCE_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['catalog.', PRODUCT_SOURCE_LABELS],
];

const TYPE_BY_ACTION: readonly (readonly [string, ValueLabels])[] = [
  ['purchases.', PURCHASE_TYPE_LABELS],
];

/** Claves que significan lo mismo en cualquier acción. */
const TOP_LEVEL_LABELS: Readonly<Record<string, ValueLabels>> = {
  method: PAYMENT_METHOD_LABELS,
  currency: CURRENCY_LABELS,
  serviceKind: SERVICE_KIND_LABELS,
  role: ROLE_LABELS,
  unit: UNIT_LABELS,
  outputUnit: UNIT_LABELS,
  roofingKind: ROOFING_PRODUCT_KIND_LABELS,
  businessLine: BUSINESS_LINE_LABELS,
  film: COIL_FILM_LABELS,
  mode: COIL_RESTORE_MODE_LABELS,
  outcome: PSE_OUTCOME_LABELS,
  priceForm: PRICE_FORM_LABELS,
  fiscalPath: POS_FISCAL_PATH_LABELS,
  reserveItemType: INVENTORY_ITEM_TYPE_LABELS,
  paymentTerms: PAYMENT_TERMS_LABELS,
  origin: ORIGIN_LABELS,
  statusBeforeAnnul: FISCAL_DOCUMENT_STATUS_LABELS,
  orderStatus: SALES_ORDER_STATUS_LABELS,
  parentStatus: COIL_STATUS_LABELS,
  atCostReason: AT_COST_REASON_LABELS,
};

const BY_ACTION: Readonly<Record<string, readonly (readonly [string, ValueLabels])[]>> = {
  status: STATUS_BY_ACTION,
  reason: REASON_BY_ACTION,
  kind: KIND_BY_ACTION,
  docType: DOC_TYPE_BY_ACTION,
  source: SOURCE_BY_ACTION,
  type: TYPE_BY_ACTION,
};

/**
 * Dentro de un objeto anidado (el ajuste de un cierre, las líneas de un comprobante movido, los
 * cambios de una compra recibida) las claves tienen su propio sentido.
 */
const NESTED_LABELS: Readonly<Record<string, ValueLabels>> = {
  kind: { ...COIL_CLOSE_ADJUSTMENT_KIND_LABELS, ...AUTO_TERMINATE_KIND_LABELS },
  refType: INVENTORY_REF_TYPE_LABELS,
  action: LINE_ACTION_LABELS,
  unit: UNIT_LABELS,
  path: RECEIVED_EDIT_PATH_LABELS,
  // El valor nuevo de un campo de la compra recibida: el tipo de comprobante o la condición de pago.
  value: { ...PURCHASE_DOC_TYPE_LABELS, ...PAYMENT_TERMS_LABELS },
};

function byAction(
  table: readonly (readonly [string, ValueLabels])[],
  action: string,
): ValueLabels | undefined {
  return table.find(([prefix]) => action.startsWith(prefix))?.[1];
}

/** Solo las propiedades propias: una clave o un valor como `constructor` no es un rótulo. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function labelsFor(key: string, action: string, nested: boolean): ValueLabels | undefined {
  if (nested) return own(NESTED_LABELS, key);
  const table = own(BY_ACTION, key);
  return table ? byAction(table, action) : own(TOP_LEVEL_LABELS, key);
}

/**
 * El valor de `key` en castellano, o `null` si no tiene traducción conocida. Un sí/no se dice
 * así; `origin` puede traer el código de otra acción (lo resuelve `actionLabel`).
 */
export function auditEnumValueLabel(
  key: string,
  value: unknown,
  action: string,
  options: { nested?: boolean; actionLabel?: (code: string) => string | null } = {},
): string | null {
  if (typeof value === 'boolean') return YES_NO[`${value}`];
  if (typeof value !== 'string') return null;
  const labels = labelsFor(key, action, options.nested === true);
  const mapped = labels ? own(labels, value) : undefined;
  if (mapped !== undefined) return mapped;
  if (key === 'origin' && options.actionLabel) return options.actionLabel(value);
  return null;
}

/**
 * Un objeto o arreglo anidado con sus valores traducidos, para mostrarlo como JSON. Las claves
 * quedan como están: solo cambian los valores que tienen traducción.
 */
export function auditTranslateNested(value: unknown, action: string): unknown {
  if (Array.isArray(value)) return value.map((v) => auditTranslateNested(v, action));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object'
        ? auditTranslateNested(v, action)
        : (auditEnumValueLabel(k, v, action, { nested: true }) ?? v),
    ]),
  );
}
