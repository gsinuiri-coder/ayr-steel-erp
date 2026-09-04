import type { QueryClient } from '@tanstack/react-query';
import { invalidateSales } from './sales-queries';

/**
 * Claves que toca cualquier operación del ciclo fiscal y logístico (D-073, D-074, D-075).
 *
 * **Reusa `invalidateSales` a propósito.** Un despacho mueve kardex, consume la reserva y
 * cambia el estado del pedido, así que invalidar solo las pantallas de comprobantes
 * dejaría `/inventario`, `/pedidos` y la terminal de planta mostrando material que ya
 * salió del almacén — el mismo razonamiento con el que 5a centralizó su invalidación en
 * vez de repetirla en cada vista.
 *
 * Emitir un comprobante no mueve stock, pero sí cambia lo que queda por facturar de un
 * pedido, y esa cifra la muestra el formulario de despacho: por eso el progreso del
 * pedido se invalida en los dos casos.
 */
export function invalidateInvoicing(
  queryClient: QueryClient,
  ids: { documentId?: string; dispatchId?: string; orderId?: string } = {},
): void {
  if (ids.documentId) {
    void queryClient.invalidateQueries({ queryKey: ['fiscal-document', ids.documentId] });
  }
  if (ids.dispatchId)
    void queryClient.invalidateQueries({ queryKey: ['dispatch', ids.dispatchId] });
  void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });
  void queryClient.invalidateQueries({ queryKey: ['dispatches'] });
  void queryClient.invalidateQueries({ queryKey: ['order-progress'] });
  void queryClient.invalidateQueries({ queryKey: ['invoicing-alerts'] });
  void queryClient.invalidateQueries({ queryKey: ['receivables'] });
  // El despacho toca stock, reserva y estado del pedido: todo lo de ventas también.
  invalidateSales(queryClient, { orderId: ids.orderId });
}
