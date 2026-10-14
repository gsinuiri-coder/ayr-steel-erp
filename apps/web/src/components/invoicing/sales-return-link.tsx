import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { LINK_CLASSNAME } from '@/lib/utils';

export type SalesReturnStatus = 'ACTIVE' | 'REVERSED';

/** cc52 (D-646): el estado de un documento de devolución, como lo dice su detalle. */
export const SALES_RETURN_STATUS_LABELS: Record<SalesReturnStatus, string> = {
  ACTIVE: 'Vigente',
  REVERSED: 'Revertida',
};

export function SalesReturnStatusBadge({ status }: { status: SalesReturnStatus }) {
  return (
    <Badge variant={status === 'ACTIVE' ? 'done' : 'outline'}>
      {SALES_RETURN_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * cc52 (D-646): el enlace al documento de devolución que generó una NC de devolución, con
 * «revertida» cuando la NC se anuló y la mercadería volvió a salir.
 */
export function SalesReturnLink({
  salesReturn,
}: {
  salesReturn: { id: string; code: string; status: SalesReturnStatus };
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link href={`/devoluciones/${salesReturn.id}`} className={LINK_CLASSNAME}>
        {salesReturn.code}
      </Link>
      {salesReturn.status === 'REVERSED' && (
        <span className="text-xs text-muted-foreground">revertida</span>
      )}
    </span>
  );
}
