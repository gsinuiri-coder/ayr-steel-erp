import type { FiscalDocumentDispatchLinkDto } from '@ayr/shared';
import { OverflowLinks } from '@/components/overflow-list';

const toItems = (dispatches: readonly FiscalDocumentDispatchLinkDto[]) =>
  dispatches.map((d) => ({ key: d.id, label: d.code, href: `/despachos/${d.id}` }));

const triggerLabel = (rest: number) =>
  rest === 1 ? 'Ver el otro despacho' : `Ver los ${String(rest)} despachos restantes`;

/**
 * Correcciones 05 / M5: a qué despacho está asociado un comprobante.
 *
 * - Declarado (`dispatches.invoice_id`): enlaces normales, el primero y «+N».
 * - Sin declarado y con pedido: los despachos **del pedido**, en gris y rotulados «Del pedido»
 *   (D-205: nunca un enlace inferido presentado como propio).
 * - Ninguno de los dos: «—».
 *
 * Sin los campos (una respuesta que no los calcula) no se dice nada: ausente no es «sin despacho».
 */
export function DocumentDispatchLinks({
  invoicedDispatches,
  orderDispatches,
  max = 1,
}: {
  invoicedDispatches: readonly FiscalDocumentDispatchLinkDto[] | undefined;
  orderDispatches: readonly FiscalDocumentDispatchLinkDto[] | undefined;
  max?: number;
}) {
  if (invoicedDispatches === undefined) return null;
  if (invoicedDispatches.length > 0) {
    return (
      <OverflowLinks
        items={toItems(invoicedDispatches)}
        max={max}
        testId="document-dispatches"
        triggerLabel={triggerLabel}
      />
    );
  }
  if (orderDispatches && orderDispatches.length > 0) {
    return (
      <span
        className="text-muted-foreground"
        data-testid="document-order-dispatches"
        title="Despachos del pedido: el comprobante no declara ninguno como propio"
      >
        Del pedido:{' '}
        <OverflowLinks
          items={toItems(orderDispatches)}
          max={max}
          linkClassName="text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
          triggerLabel={(rest) =>
            rest === 1
              ? 'Ver el otro despacho del pedido'
              : `Ver los ${String(rest)} despachos restantes del pedido`
          }
        />
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
