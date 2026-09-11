import {
  DISPATCH_STATUS_LABELS,
  FISCAL_DOCUMENT_STATUS_LABELS,
  type DispatchStatus,
  type FiscalDocumentStatus,
} from '@ayr/shared';
import { DISPATCH_TONE, fiscalDocumentTone } from '@/components/status-tone';
import { Badge } from '@/components/ui/badge';

/**
 * Badges del ciclo fiscal y logístico (D-073, D-074).
 *
 * Viven fuera de las vistas por el mismo motivo que los de ventas: los usan la lista y el
 * detalle, y importarlos desde la lista arrastraba su tabla y sus filtros al bundle del
 * detalle.
 *
 * D-180: el tono ya no se decide acá. `ISSUED` sigue sin ser un estado neutro —el
 * correlativo ya está tomado y el PSE todavía no contestó— y cuando el envío se queda en el
 * camino pasa a aviso; las dos cosas las dice `fiscalDocumentTone`. Los dos terminales
 * "anulado" comparten aspecto porque comparten consecuencia —el documento dejó de deber— y
 * se distinguen por la etiqueta, que es donde está la diferencia que importa (D-110).
 */
export function FiscalDocumentStatusBadge({
  status,
  isStalled = false,
}: {
  status: FiscalDocumentStatus;
  isStalled?: boolean;
}) {
  return (
    <Badge variant={fiscalDocumentTone(status, isStalled)}>
      {FISCAL_DOCUMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function DispatchStatusBadge({ status }: { status: DispatchStatus }) {
  return <Badge variant={DISPATCH_TONE[status]}>{DISPATCH_STATUS_LABELS[status]}</Badge>;
}
