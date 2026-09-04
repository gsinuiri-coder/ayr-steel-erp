import type { QueryClient } from '@tanstack/react-query';

/**
 * Claves de consulta que toca cualquier operación de una orden de producción. Vive en
 * `lib` y no dentro de una vista para que la terminal de planta no arrastre el bundle de
 * la vista de detalle solo por reusar esta función.
 *
 * Consumir, reportar, cerrar, reabrir o anular una OP mueve —según el caso— el kardex del
 * fleje, el del producto terminado, el stock de flejes (RF-42) y el inventario valorizado
 * (RF-51): si falta alguna clave, la pantalla de al lado sigue mostrando datos viejos.
 */
export function invalidateProduction(queryClient: QueryClient, orderId?: string): void {
  if (orderId) void queryClient.invalidateQueries({ queryKey: ['production-order', orderId] });
  void queryClient.invalidateQueries({ queryKey: ['production-orders'] });
  void queryClient.invalidateQueries({ queryKey: ['production-strips'] });
  void queryClient.invalidateQueries({ queryKey: ['coils'] });
  void queryClient.invalidateQueries({ queryKey: ['coil'] });
  void queryClient.invalidateQueries({ queryKey: ['cutting', 'strips'] });
  void queryClient.invalidateQueries({ queryKey: ['inventory'] });
  // D-066: reportar consume la reserva del pedido y lo pasa a "en producción"; revertir o
  // anular la orden la devuelve. Sin estas claves, las pantallas de ventas siguen mostrando
  // el estado anterior — la simetría con `invalidateSales` tiene que valer en los dos sentidos.
  void queryClient.invalidateQueries({ queryKey: ['reservations'] });
  void queryClient.invalidateQueries({ queryKey: ['sales-order'] });
  void queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
  void queryClient.invalidateQueries({ queryKey: ['quotation'] });
  void queryClient.invalidateQueries({ queryKey: ['quotations'] });
}
