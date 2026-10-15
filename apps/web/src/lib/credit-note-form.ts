import {
  CREDIT_NOTE_GROUP_REASONS,
  CREDIT_NOTE_GROUPS,
  MAX_BACKDATED_ISSUE_DAYS,
  addDays,
  toDecimal,
  type CreditNoteGroup,
  type CreditNoteReason,
} from '@ayr/shared';
import { isPositiveDecimal } from './format';

/** `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** cc54 (D-663): el grupo (tarjeta) al que pertenece un motivo SUNAT. */
export function creditNoteGroupOfReason(reason: CreditNoteReason): CreditNoteGroup {
  return CREDIT_NOTE_GROUPS.find((g) => CREDIT_NOTE_GROUP_REASONS[g].includes(reason)) ?? 'ANULAR';
}

/** cc54: el motivo con que arranca una tarjeta al elegirla. */
export function defaultReasonOfGroup(group: CreditNoteGroup): CreditNoteReason {
  const first = CREDIT_NOTE_GROUP_REASONS[group][0];
  if (first === undefined) throw new Error(`La tarjeta ${group} no tiene motivos`);
  return first;
}

/**
 * cc52 (D-645): la fecha de la NC, con las mismas reglas que el API. No antes de la emisión del
 * comprobante afectado, no después de hoy y no más atrás que la ventana de emisión
 * (`MAX_BACKDATED_ISSUE_DAYS`). Solo el ADMINISTRADOR elige otra fecha que hoy. `null` si vale.
 * Las fechas son `YYYY-MM-DD`, que se comparan como texto.
 */
export function creditNoteDateError(
  date: string,
  invoiceIssueDate: string,
  today: string,
  isAdmin: boolean,
): string | null {
  if (!ISO_DATE.test(date)) return 'Escribe una fecha válida';
  if (!isAdmin && date !== today) {
    return 'Solo un administrador puede registrar la nota con otra fecha que hoy';
  }
  if (date > today) return 'La fecha de la nota no puede ser posterior a hoy';
  if (date < invoiceIssueDate) {
    return 'La fecha de la nota no puede ser anterior a la emisión del comprobante';
  }
  if (date < addDays(today, -MAX_BACKDATED_ISSUE_DAYS)) {
    return `La fecha de la nota no puede tener más de ${MAX_BACKDATED_ISSUE_DAYS} días de atraso`;
  }
  return null;
}

/** Lo que el usuario escribió en el paso 2, por línea del comprobante (ids de línea). */
export interface CreditNoteDraft {
  reason: CreditNoteReason;
  issueDate: string;
  notes: string;
  /** 07: cantidad devuelta por línea. */
  qty: Record<string, string>;
  /** 05: precio nuevo con IGV por línea. */
  price: Record<string, string>;
  /** 03: descripción corregida por línea. */
  description: Record<string, string>;
  /** 04: monto con IGV. */
  amount: string;
  /** 13: vencimiento nuevo. */
  dueDate: string;
  /** 02: el comprobante de reemplazo. */
  replacement: { customerId: string; issueDate: string; series: string; correlative: string };
}

export function emptyCreditNoteDraft(reason: CreditNoteReason, today: string): CreditNoteDraft {
  return {
    reason,
    issueDate: today,
    notes: '',
    qty: {},
    price: {},
    description: {},
    amount: '',
    dueDate: '',
    replacement: { customerId: '', issueDate: today, series: '', correlative: '' },
  };
}

const SERIES = /^[A-Z][A-Z0-9]{3}$/;

/** Los valores escritos (sin vacíos), en el orden de las líneas. */
const filled = (map: Record<string, string>) =>
  Object.entries(map)
    .map(([id, v]) => [id, v.trim()] as const)
    .filter(([, v]) => v !== '');

/**
 * cc54: el cuerpo que el API espera para el motivo elegido, o el motivo por el que todavía no se
 * puede pedir (`{ error }`). La vista previa y el registro mandan exactamente esto.
 */
export function creditNoteBody(
  draft: CreditNoteDraft,
): { body: Record<string, unknown> } | { error: string } {
  const base: Record<string, unknown> = {
    reason: draft.reason,
    issueDate: draft.issueDate,
    ...(draft.notes.trim() === '' ? {} : { notes: draft.notes.trim() }),
  };
  switch (draft.reason) {
    case 'ANULACION_OPERACION':
    case 'DEVOLUCION_TOTAL':
      return { body: base };
    case 'DEVOLUCION_ITEM': {
      const items = filled(draft.qty);
      if (items.some(([, q]) => !isPositiveDecimal(q))) {
        return { error: 'Revisa las cantidades: tienen que ser mayores a cero' };
      }
      if (items.length === 0)
        return { error: 'Escribe la cantidad devuelta de al menos una línea' };
      return {
        body: { ...base, items: items.map(([affectedItemId, qty]) => ({ affectedItemId, qty })) },
      };
    }
    case 'DESCUENTO_ITEM': {
      const prices = filled(draft.price);
      const bad = prices.some(([, p]) => {
        if (!/^\d+(\.\d+)?$/.test(p)) return true;
        return toDecimal(p).decimalPlaces() > 4;
      });
      if (bad) return { error: 'Revisa los precios nuevos: números con hasta cuatro decimales' };
      if (prices.length === 0) return { error: 'Escribe el precio nuevo de al menos una línea' };
      return {
        body: {
          ...base,
          prices: prices.map(([affectedItemId, unitPriceWithIgvPen]) => ({
            affectedItemId,
            unitPriceWithIgvPen,
          })),
        },
      };
    }
    case 'DESCUENTO_GLOBAL': {
      const amount = draft.amount.trim();
      if (!isPositiveDecimal(amount)) return { error: 'Escribe el monto a rebajar' };
      if (toDecimal(amount).decimalPlaces() > 2) {
        return { error: 'El monto va con hasta dos decimales (céntimos)' };
      }
      return { body: { ...base, amountPen: amount } };
    }
    case 'CORRECCION_DESCRIPCION': {
      const descriptions = filled(draft.description);
      if (descriptions.length === 0) {
        return { error: 'Escribe la descripción corregida de al menos una línea' };
      }
      return {
        body: {
          ...base,
          descriptions: descriptions.map(([affectedItemId, description]) => ({
            affectedItemId,
            description,
          })),
        },
      };
    }
    case 'OTROS_AJUSTES':
      if (!ISO_DATE.test(draft.dueDate)) return { error: 'Elige el vencimiento nuevo' };
      return { body: { ...base, dueDate: draft.dueDate } };
    case 'ANULACION_ERROR_RUC': {
      const r = draft.replacement;
      if (r.customerId === '') return { error: 'Elige el cliente correcto' };
      if (!SERIES.test(r.series.trim().toUpperCase())) {
        return { error: 'La serie del reemplazo son cuatro caracteres (ej: F001)' };
      }
      if (!/^\d{1,8}$/.test(r.correlative.trim()) || Number(r.correlative) < 1) {
        return { error: 'Escribe el número del comprobante de reemplazo' };
      }
      if (!ISO_DATE.test(r.issueDate)) return { error: 'Elige la fecha del reemplazo' };
      return {
        body: {
          ...base,
          replacement: {
            customerId: r.customerId,
            issueDate: r.issueDate,
            series: r.series.trim().toUpperCase(),
            correlative: Number(r.correlative),
          },
        },
      };
    }
  }
}

/** cc54 (D-660): la serie y el número del papel de la nota, o el motivo por el que faltan. */
export function paperNumberError(series: string, correlative: string): string | null {
  if (!SERIES.test(series.trim().toUpperCase())) {
    return 'La serie de la nota son cuatro caracteres (ej: FC01)';
  }
  if (!/^\d{1,8}$/.test(correlative.trim()) || Number(correlative) < 1) {
    return 'Escribe el número de la nota';
  }
  return null;
}
