import {
  QUOTATION_STATUS_LABELS,
  SALES_ORDER_STATUS_LABELS,
  type QuotationStatus,
  type SalesOrderStatus,
} from '@ayr/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Badges de estado de cotización y pedido.
 *
 * Viven acá y no dentro de las vistas de lista porque los detalles también los usan: al
 * importarlos desde la lista, cada detalle arrastraba al bundle su tabla, sus selects y sus
 * filtros — lo mismo que `production-queries.ts` evita con la invalidación.
 */

/** Solo la confirmada es un hecho; vencida y anulada son terminales. */
export function QuotationStatusBadge({
  status,
  isExpired,
}: {
  status: QuotationStatus;
  isExpired: boolean;
}) {
  const label = QUOTATION_STATUS_LABELS[status];
  if (status === 'CONFIRMED') return <Badge>{label}</Badge>;
  if (status === 'CANCELLED' || status === 'EXPIRED') {
    return <Badge variant="outline">{label}</Badge>;
  }
  // Una emitida cuya fecha ya pasó pero que el job todavía no marcó: se avisa igual, o la
  // lista diría "Emitida" sobre algo que confirmar va a rechazar.
  if (status === 'EMITTED' && isExpired) return <Badge variant="outline">Vencida</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

export function SalesOrderStatusBadge({ status }: { status: SalesOrderStatus }) {
  const label = SALES_ORDER_STATUS_LABELS[status];
  if (status === 'CANCELLED') return <Badge variant="outline">{label}</Badge>;
  if (status === 'FULFILLED') return <Badge variant="secondary">{label}</Badge>;
  return <Badge>{label}</Badge>;
}
