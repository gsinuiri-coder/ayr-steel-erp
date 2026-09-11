import type {
  CoilSplitStatus,
  CoilStatus,
  CuttingOrderCoilStatus,
  CuttingOrderStatus,
  DispatchStatus,
  ProductionReportStatus,
  FiscalDocumentStatus,
  ProductionOrderStatus,
  PurchaseStatus,
  QuotationStatus,
  ReservationStatus,
  SalesOrderStatus,
} from '@ayr/shared';

/**
 * D-180 — qué tono le toca a cada estado de dominio, en un solo lugar.
 *
 * El problema que resuelve: cada vista elegía su `variant` de `Badge` por su cuenta, y el
 * mismo color terminó queriendo decir cosas distintas. En comprobantes el negro sólido era
 * «Aceptada» (terminó bien); en pedidos era «En producción» (sigue en curso) y «Atendido»
 * —el terminal bueno— era el gris más apagado. Aprender la convención era imposible porque
 * no había una.
 *
 * Los cuatro significados y su tono están descritos en `globals.css`, junto a los tokens.
 * Acá vive solo el mapa, y vive **completo a propósito**: son `Record<Status, Tone>`
 * exhaustivos, así que un estado nuevo en `@ayr/shared` no compila hasta que alguien decida
 * qué significa. Un `default` silencioso es justo lo que dejó entrar el desorden anterior.
 */
export type StatusTone = 'outline' | 'progress' | 'done' | 'warning' | 'destructive';

/** Una cotización: el hecho es confirmarla; vencida pide acción, anulada ya no. */
export const QUOTATION_TONE: Record<QuotationStatus, StatusTone> = {
  DRAFT: 'outline',
  EMITTED: 'progress',
  CONFIRMED: 'done',
  EXPIRED: 'warning',
  CANCELLED: 'outline',
};

/** Un pedido está en curso hasta que se atiende entero. */
export const SALES_ORDER_TONE: Record<SalesOrderStatus, StatusTone> = {
  CONFIRMED: 'progress',
  IN_PRODUCTION: 'progress',
  PARTIALLY_FULFILLED: 'progress',
  FULFILLED: 'done',
  CANCELLED: 'outline',
};

/**
 * El ciclo fiscal (D-073, D-110).
 *
 * `ISSUED` no es «todo bien»: el correlativo ya está tomado y el PSE no contestó. Es un
 * estado en curso, y cuando se queda en el camino pasa a `warning` (ver `fiscalDocumentTone`).
 * Los dos anulados son neutros: son decisiones tomadas, no errores.
 */
export const FISCAL_DOCUMENT_TONE: Record<FiscalDocumentStatus, StatusTone> = {
  DRAFT: 'outline',
  ISSUED: 'progress',
  ACCEPTED: 'done',
  REJECTED: 'destructive',
  SEND_ERROR: 'destructive',
  VOID_PENDING: 'warning',
  VOIDED: 'outline',
  ANNULLED: 'outline',
};

/** Un envío al PSE que dejó de estar en camino es algo que mirar, no un error todavía. */
export function fiscalDocumentTone(status: FiscalDocumentStatus, isStalled: boolean): StatusTone {
  if (isStalled && (status === 'ISSUED' || status === 'VOID_PENDING')) return 'warning';
  return FISCAL_DOCUMENT_TONE[status];
}

/** El material salió del almacén: es un hecho consumado. Revertirlo lo deja en neutro. */
export const DISPATCH_TONE: Record<DispatchStatus, StatusTone> = {
  ISSUED: 'done',
  REVERSED: 'outline',
};

/** Una bobina en corte tercerizado sigue en curso, solo que fuera de casa (D-052). */
export const COIL_TONE: Record<CoilStatus, StatusTone> = {
  OPEN: 'progress',
  CLOSED: 'done',
  CANCELLED: 'outline',
  IN_THIRD_PARTY: 'progress',
};

export const PRODUCTION_ORDER_TONE: Record<ProductionOrderStatus, StatusTone> = {
  DRAFT: 'outline',
  IN_PROGRESS: 'progress',
  CLOSED: 'done',
  CANCELLED: 'outline',
};

/** Una reserva consumida cumplió su función: terminó bien (D-064). */
export const RESERVATION_TONE: Record<ReservationStatus, StatusTone> = {
  ACTIVE: 'progress',
  CONSUMED: 'done',
  RELEASED: 'outline',
};

export const PURCHASE_TONE: Record<PurchaseStatus, StatusTone> = {
  DRAFT: 'outline',
  RECEIVED: 'done',
  CANCELLED: 'outline',
};

/** El corte tercerizado sigue en curso mientras quede material afuera (RF-40..42). */
export const CUTTING_ORDER_TONE: Record<CuttingOrderStatus, StatusTone> = {
  SENT: 'progress',
  PARTIALLY_RECEIVED: 'progress',
  RECEIVED: 'done',
  CANCELLED: 'outline',
};

/** La bobina de una orden de corte, fila por fila. */
export const CUTTING_ORDER_COIL_TONE: Record<CuttingOrderCoilStatus, StatusTone> = {
  SENT: 'progress',
  RECEIVED: 'done',
  CANCELLED: 'outline',
};

/**
 * Un partido de bobina y un reporte de producción comparten forma: viven o fueron
 * revertidos. Un revertido es neutro, no un error — la reversa es una operación normal del
 * dominio (D-052, D-061), no un fallo.
 */
export const COIL_SPLIT_TONE: Record<CoilSplitStatus, StatusTone> = {
  ACTIVE: 'done',
  REVERTED: 'outline',
};

export const PRODUCTION_REPORT_TONE: Record<ProductionReportStatus, StatusTone> = {
  ACTIVE: 'done',
  REVERTED: 'outline',
};
