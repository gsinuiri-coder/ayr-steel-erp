/**
 * D-379: parámetro con el que el detalle del comprobante abre «Restaurar reserva» en el pedido,
 * sobre una reserva concreta.
 */
export const RESTORE_RESERVATION_PARAM = 'restaurarReserva';

/** El enlace del comprobante al pedido, con el diálogo de restaurar abierto. */
export function restoreReservationHref(salesOrderId: string, reservationId: string): string {
  return `/pedidos/${salesOrderId}?${RESTORE_RESERVATION_PARAM}=${reservationId}`;
}
