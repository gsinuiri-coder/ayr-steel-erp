/**
 * F8-S3b/M2: las direcciones de `/planta`, en un solo lugar.
 *
 * - `/planta` — pedidos con producción pendiente.
 * - `/planta?pedido=<id>` — la producción de ese pedido (`sin-pedido` para las corridas a
 *   stock); con `&op=<id>`, esa orden abierta en el workspace.
 * - `/planta?op=<id>` — se resuelve al pedido de la orden.
 * - `/planta?historial=1` — el historial de órdenes (D-190).
 */
export function plantaHref(params: { pedido?: string; op?: string; historial?: boolean }): string {
  const search = new URLSearchParams();
  if (params.pedido) search.set('pedido', params.pedido);
  if (params.op) search.set('op', params.op);
  if (params.historial) search.set('historial', '1');
  const query = search.toString();
  return query === '' ? '/planta' : `/planta?${query}`;
}
