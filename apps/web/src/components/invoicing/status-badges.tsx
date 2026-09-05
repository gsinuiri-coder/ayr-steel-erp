import {
  DISPATCH_STATUS_LABELS,
  FISCAL_DOCUMENT_STATUS_LABELS,
  type DispatchStatus,
  type FiscalDocumentStatus,
} from '@ayr/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Badges del ciclo fiscal y logístico (D-073, D-074).
 *
 * Viven fuera de las vistas por el mismo motivo que los de ventas: los usan la lista y el
 * detalle, y importarlos desde la lista arrastraba su tabla y sus filtros al bundle del
 * detalle.
 */

/**
 * Estado de un documento electrónico.
 *
 * `ISSUED` **no es un estado neutro**: significa que el correlativo ya está tomado y que
 * el PSE todavía no contestó (D-073). Se muestra como aviso y no como "todo bien", porque
 * la mercadería ya puede salir pero el comprobante todavía no está declarado. Con
 * `isStalled` pasa a destacarse: dejó de estar en camino y es un problema.
 */
export function FiscalDocumentStatusBadge({
  status,
  isStalled = false,
}: {
  status: FiscalDocumentStatus;
  isStalled?: boolean;
}) {
  const label = FISCAL_DOCUMENT_STATUS_LABELS[status];
  if (status === 'ACCEPTED') return <Badge>{label}</Badge>;
  if (status === 'REJECTED' || status === 'SEND_ERROR') {
    return <Badge variant="destructive">{label}</Badge>;
  }
  // D-110: los dos terminales "anulado" comparten aspecto porque comparten consecuencia
  // —el documento dejó de deber—, y se distinguen por la etiqueta, que es donde está la
  // diferencia que importa: uno lo anuló SUNAT y el otro, un administrador acá.
  if (status === 'VOIDED' || status === 'ANNULLED') {
    return <Badge variant="outline">{label}</Badge>;
  }
  if (status === 'ISSUED' || status === 'VOID_PENDING') {
    return <Badge variant={isStalled ? 'destructive' : 'secondary'}>{label}</Badge>;
  }
  return <Badge variant="secondary">{label}</Badge>;
}

export function DispatchStatusBadge({ status }: { status: DispatchStatus }) {
  const label = DISPATCH_STATUS_LABELS[status];
  return status === 'REVERSED' ? <Badge variant="outline">{label}</Badge> : <Badge>{label}</Badge>;
}
