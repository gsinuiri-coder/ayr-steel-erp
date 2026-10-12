import { auditFieldLabel, auditFieldValueLabel, isPriceListValueField } from './audit-labels';
import { money, toFixedString } from './decimal';
import { salePriceFromValue } from './tax';

/** Lo que el detalle de un evento necesita saber de él. */
export interface AuditDetailEvent {
  source: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Los campos que cambiaron entre `before` y `after` (D-218/M3): el visor y su Excel (cc48, D-634)
 * muestran solo esos, nunca un volcado del JSON.
 */
export function auditChangedKeys(event: AuditDetailEvent): string[] {
  const keys = [
    ...new Set([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})]),
  ];
  return keys.filter((k) => JSON.stringify(event.before?.[k]) !== JSON.stringify(event.after?.[k]));
}

/** Un valor del detalle como texto plano; el precio de lista, con IGV como en el catálogo. */
export function auditValueText(event: AuditDetailEvent, key: string, value: unknown): string {
  if (isPriceListValueField(event.source, event.action, key)) {
    if (value === null || value === undefined) return '—';
    return `S/ ${toFixedString(money(salePriceFromValue(value as string)), 'MONEY')}`;
  }
  const mapped = auditFieldValueLabel(key, value);
  if (mapped) return mapped;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * cc48 (D-634): el detalle de un evento en una línea, para el Excel: «Campo: antes → después», un
 * campo por renglón. Sin cambios, lo dice.
 */
export function auditDetailText(event: AuditDetailEvent): string {
  const changed = auditChangedKeys(event);
  if (changed.length === 0) return 'Sin detalle registrado.';
  return changed
    .map((k) => {
      const hasBefore = event.before !== null && k in event.before;
      const hasAfter = event.after !== null && k in event.after;
      const parts = [
        ...(hasBefore ? [auditValueText(event, k, event.before?.[k])] : []),
        ...(hasAfter ? [auditValueText(event, k, event.after?.[k])] : []),
      ];
      return `${auditFieldLabel(k)}: ${parts.join(' → ')}`;
    })
    .join('\n');
}
