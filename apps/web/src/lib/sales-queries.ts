import type { QueryClient } from '@tanstack/react-query';

/**
 * Claves de consulta que toca cualquier operación del ciclo comercial (D-054, D-066).
 *
 * Confirmar, anular un pedido o liberar una reserva cambia el **disponible** de un ítem sin
 * mover el kardex, así que invalidar solo las pantallas de ventas dejaría `/inventario`,
 * `/flejes` y la terminal de planta mostrando material que ya está prometido. Es el mismo
 * criterio que `invalidateProduction`, y por el mismo motivo vive en `lib`.
 */
export function invalidateSales(
  queryClient: QueryClient,
  ids: { quotationId?: string; orderId?: string } = {},
): void {
  if (ids.quotationId)
    void queryClient.invalidateQueries({ queryKey: ['quotation', ids.quotationId] });
  if (ids.orderId) void queryClient.invalidateQueries({ queryKey: ['sales-order', ids.orderId] });
  void queryClient.invalidateQueries({ queryKey: ['quotations'] });
  void queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
  void queryClient.invalidateQueries({ queryKey: ['reservations'] });
  void queryClient.invalidateQueries({ queryKey: ['reservable-coils'] });
  void queryClient.invalidateQueries({ queryKey: ['inventory'] });
  void queryClient.invalidateQueries({ queryKey: ['coils'] });
  void queryClient.invalidateQueries({ queryKey: ['coil'] });
  void queryClient.invalidateQueries({ queryKey: ['cutting', 'strips'] });
  void queryClient.invalidateQueries({ queryKey: ['production-strips'] });
  // Fase 7 (D-092..D-096): prioridad, fecha prometida y cualquier transición de reserva
  // cambian el orden o la presencia de un pedido en la cola derivada.
  void queryClient.invalidateQueries({ queryKey: ['production-queue'] });
}
