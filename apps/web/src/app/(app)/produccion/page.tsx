import { redirect } from 'next/navigation';

/**
 * D-190: el listado de órdenes de producción salió de la navegación. La cola y el workspace
 * viven en `/planta` (con el historial completo como sección plegable), y las órdenes de un
 * pedido en su detalle. `/produccion/:id` —el detalle de una orden— se conserva: lo enlazan la
 * bobina, el pedido y el propio workspace.
 */
export default function ProduccionPage() {
  redirect('/planta?historial=1');
}
