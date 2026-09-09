import { redirect } from 'next/navigation';

/**
 * D-160: el espacio de producción del pedido y la terminal de planta se fundieron en `/planta`,
 * que es ahora la **única** entrada a producir. Esta ruta queda solo como redirección: es la
 * vieja —que cualquiera pudo dejar guardada, y a la que apuntaban el detalle del pedido y el
 * de la orden— señalando a la que existe. El `?pedido=` viaja tal cual, así que quien llegue
 * desde un pedido sigue cayendo acotado a sus órdenes.
 */
export default async function ProducirRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pedido = (await searchParams).pedido;
  const id = Array.isArray(pedido) ? pedido[0] : pedido;
  redirect(id ? `/planta?pedido=${id}` : '/planta');
}
