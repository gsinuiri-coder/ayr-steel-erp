import { auditTextSearchApplies } from '@ayr/shared';

/**
 * cc48 (D-634): lo que la auditoría guarda en la URL —el buscar y los filtros—, para que refrescar
 * y volver atrás den la misma lista, y para que su Excel reciba exactamente lo mismo. D-635: el
 * «Historial» de un documento entra con `entityType` y `entityId`.
 */
export const AUDIT_URL_DEFAULTS = {
  search: '',
  entityType: '',
  entityId: '',
  actorId: '',
  action: '',
  from: '',
  to: '',
};
export type AuditUrl = typeof AUDIT_URL_DEFAULTS;

/** El tope del buscar en el API (`auditQuerySchema`). */
const SEARCH_MAX = 80;

/** Los parámetros del API para esta URL: la lista y su Excel (sin página). */
export function auditParamsOf(url: AuditUrl): URLSearchParams {
  const params = new URLSearchParams();
  const search = url.search.trim().slice(0, SEARCH_MAX);
  if (search) params.set('search', search);
  if (url.entityType) {
    params.set('entityType', url.entityType);
    // El id solo vale con su tipo (el API lo exige).
    if (url.entityId) params.set('entityId', url.entityId);
  }
  if (url.actorId) params.set('actorId', url.actorId);
  if (url.action) params.set('action', url.action);
  if (url.from) params.set('from', url.from);
  if (url.to) params.set('to', url.to);
  return params;
}

/** Cuántos filtros del modal están puestos (el periodo cuenta uno). */
export function auditActiveFilterCount(url: AuditUrl): number {
  return [url.entityType, url.actorId, url.action, url.from || url.to].filter(Boolean).length;
}

/**
 * Lo que dice la línea de estado sin fechas: los 31 días de siempre, o los 12 meses del historial
 * de un documento (D-635, el API usa el rango más largo). Con fechas, nada.
 */
export function auditDefaultPeriodLabel(url: AuditUrl): string | null {
  if (url.from || url.to) return null;
  return url.entityType && url.entityId ? 'Últimos 12 meses' : 'Últimos 31 días';
}

/**
 * cc48 (D-634, regla del dueño): con buscar y un periodo de más de 31 días, el API busca solo por
 * código legible; la pantalla lo avisa. `null` si no hace falta avisar.
 */
export function auditSearchNotice(url: AuditUrl, today: string): string | null {
  if (url.search.trim() === '') return null;
  const widest = Boolean(url.entityType && url.entityId);
  if (auditTextSearchApplies(url.from, url.to, today, widest)) return null;
  return 'Con más de 31 días, el buscar encuentra solo por código; el texto del detalle se busca con 31 días o menos.';
}
