import { redirect } from 'next/navigation';

/**
 * D-155: la tanda de D-147 se reconvirtió en el espacio de producción del pedido, y esta
 * ruta queda solo como redirección. No es una segunda puerta: es la vieja, que cualquiera
 * pudo dejar guardada, apuntando a la única que existe. El `?pedido=` viaja tal cual —era el
 * único parámetro que la tanda entendía— y con él la vista nueva abre acotada al mismo
 * pedido en vez de a la planta entera.
 */
export default async function TandaRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pedido = (await searchParams).pedido;
  const id = Array.isArray(pedido) ? pedido[0] : pedido;
  // D-160: el destino pasó a ser `/planta`, la única entrada a producir.
  redirect(id ? `/planta?pedido=${id}` : '/planta');
}
