import type { Metadata } from 'next';
import { ClientesView } from '../clientes-view';

export const metadata: Metadata = { title: 'Nuevo cliente' };

/**
 * Alta de cliente con la búsqueda de RUC/DNI (D-067). Reusa la vista de la lista con el
 * diálogo ya abierto en vez de duplicar el formulario: el alta de todos los maestros del
 * proyecto vive en un diálogo, y dos formularios de cliente divergirían en la validación
 * o en el lookup a la primera corrección.
 */
export default function NuevoClientePage() {
  return <ClientesView autoOpenNew />;
}
