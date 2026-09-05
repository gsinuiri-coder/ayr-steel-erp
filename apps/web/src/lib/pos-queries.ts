import type { QueryClient } from '@tanstack/react-query';
import { invalidateInvoicing } from './invoicing-queries';

/**
 * Claves que toca una venta de mostrador (D-099).
 *
 * **Reusa `invalidateInvoicing`, que a su vez reusa `invalidateSales`**, por el mismo motivo
 * por el que el servicio del POS reusa los servicios de esas dos fases: una venta de
 * mostrador crea un pedido, un despacho, un comprobante y un cobro de verdad, así que deja
 * desactualizadas exactamente las mismas pantallas que crearlos por separado — inventario,
 * kardex, pedidos, despachos, comprobantes y cobranzas incluidas.
 *
 * Lo único propio son las dos claves del mostrador: el contexto (que trae el turno abierto)
 * y las ventas del turno, que es lo que hace que la caja sume en la pantalla en el mismo
 * momento en que suma en la base.
 */
export function invalidatePos(
  queryClient: QueryClient,
  ids: { cashSessionId?: string; orderId?: string; documentId?: string } = {},
): void {
  void queryClient.invalidateQueries({ queryKey: ['pos-context'] });
  void queryClient.invalidateQueries({ queryKey: ['pos-products'] });
  void queryClient.invalidateQueries({ queryKey: ['cash-sessions'] });
  if (ids.cashSessionId) {
    void queryClient.invalidateQueries({ queryKey: ['cash-session', ids.cashSessionId] });
    void queryClient.invalidateQueries({ queryKey: ['cash-session-sales', ids.cashSessionId] });
  } else {
    void queryClient.invalidateQueries({ queryKey: ['cash-session'] });
    void queryClient.invalidateQueries({ queryKey: ['cash-session-sales'] });
  }
  invalidateInvoicing(queryClient, { orderId: ids.orderId, documentId: ids.documentId });
}
