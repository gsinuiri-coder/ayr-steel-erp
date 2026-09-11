import {
  QUOTATION_STATUS_LABELS,
  SALES_ORDER_STATUS_LABELS,
  type QuotationStatus,
  type SalesOrderStatus,
} from '@ayr/shared';
import { QUOTATION_TONE, SALES_ORDER_TONE } from '@/components/status-tone';
import { Badge } from '@/components/ui/badge';

/**
 * Badges de estado de cotización y pedido.
 *
 * Viven acá y no dentro de las vistas de lista porque los detalles también los usan: al
 * importarlos desde la lista, cada detalle arrastraba al bundle su tabla, sus selects y sus
 * filtros — lo mismo que `production-queries.ts` evita con la invalidación.
 *
 * D-180: el tono ya no lo elige este archivo, lo dice `status-tone.ts` para todo el sistema.
 */
export function QuotationStatusBadge({
  status,
  isExpired,
}: {
  status: QuotationStatus;
  isExpired: boolean;
}) {
  // Una emitida cuya fecha ya pasó pero que el job todavía no marcó: se avisa igual, o la
  // lista diría "Emitida" sobre algo que confirmar va a rechazar.
  const expired = status === 'EMITTED' && isExpired;
  const label = expired ? 'Vencida' : QUOTATION_STATUS_LABELS[status];
  return <Badge variant={expired ? 'warning' : QUOTATION_TONE[status]}>{label}</Badge>;
}

export function SalesOrderStatusBadge({ status }: { status: SalesOrderStatus }) {
  return <Badge variant={SALES_ORDER_TONE[status]}>{SALES_ORDER_STATUS_LABELS[status]}</Badge>;
}
