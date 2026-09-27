import type { ReactNode } from 'react';
import type { SalesOrderDocumentLinkDto } from '@ayr/shared';
import { OverflowLinks, type OverflowItem } from '@/components/overflow-list';

/**
 * Correcciones 05 / M4: los comprobantes vivos de un pedido como enlaces. La nota de crédito
 * lleva su tipo al lado: resta, y leída sola se confundía con «la factura del pedido».
 */
function toItems(documents: readonly SalesOrderDocumentLinkDto[]): OverflowItem[] {
  return documents.map((d) => ({
    key: d.id,
    href: `/comprobantes/${d.id}`,
    label:
      d.docType === 'NOTA_CREDITO' ? (
        <>
          {d.number ?? 'Sin número'} <span className="text-xs">(NC)</span>
        </>
      ) : (
        (d.number ?? 'Sin número')
      ),
  }));
}

/** El primero y «+N» con el resto (lista de pedidos); todos si `max` alcanza (detalle). */
export function OrderDocumentLinks({
  documents,
  max = 1,
  empty,
}: {
  documents: readonly SalesOrderDocumentLinkDto[];
  max?: number;
  empty?: ReactNode;
}) {
  return (
    <OverflowLinks
      items={toItems(documents)}
      max={max}
      testId="order-documents"
      empty={empty}
      triggerLabel={(rest) =>
        rest === 1 ? 'Ver el otro comprobante' : `Ver los ${String(rest)} comprobantes restantes`
      }
    />
  );
}
