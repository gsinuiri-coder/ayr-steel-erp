'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_REASONS,
  Role,
  type CreditNoteReason,
  type SalesReturnDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty, formatTimestampDate, unitSymbol } from '@/lib/format';
import { CrumbLabel } from '@/components/breadcrumb';
import { SalesReturnStatusBadge } from '@/components/invoicing/sales-return-link';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuditHistoryLink } from '@/components/audit-history-link';
import { Section } from '@/components/section';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DetailSummary } from '@/components/detail-summary';

/** Los mismos roles que el API de `/invoicing` (comercial). */
const RETURN_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

function reasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return CREDIT_NOTE_REASONS.includes(reason as CreditNoteReason)
    ? CREDIT_NOTE_REASON_LABELS[reason as CreditNoteReason]
    : reason;
}

/** El ítem que reingresó: la bobina a su detalle, el producto a su kardex. */
function itemHref(item: SalesReturnDto['items'][number]): string {
  return item.itemType === 'COIL'
    ? `/bobinas/${item.itemId}`
    : `/kardex?itemType=PRODUCT&item=${item.itemId}&range=all`;
}

/**
 * cc52 (D-646): el documento de devolución de una NC de devolución. La mercadería reingresó al
 * almacén con la fecha de la nota y al costo con que salió en su despacho. Solo se lee: se
 * revierte anulando la nota de crédito. El costo, solo para el ADMINISTRADOR (el API lo manda
 * en `null` a los demás).
 */
export function DevolucionDetalleView({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['sales-return', id],
    queryFn: () => api<SalesReturnDto>(`/invoicing/returns/${id}`),
  });
  const r = query.data;

  if (query.isPending) {
    return (
      <RoleGate allow={RETURN_ROLES}>
        <Skeleton className="h-64 w-full" />
      </RoleGate>
    );
  }
  if (query.isError || !r) {
    return (
      <RoleGate allow={RETURN_ROLES}>
        <Alert variant="destructive">
          <AlertDescription>No se pudo cargar la devolución.</AlertDescription>
        </Alert>
      </RoleGate>
    );
  }

  const showCost = r.totalCostPen !== null;
  const reason = reasonLabel(r.creditNoteReason);

  return (
    <RoleGate allow={RETURN_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <CrumbLabel label={r.code} />
          <h1 className="text-xl font-semibold">Devolución {r.code}</h1>
          <SalesReturnStatusBadge status={r.status} />
        </div>
        <AuditHistoryLink entityType="sales_returns" entityId={r.id} />
      </div>

      <DetailSummary
        items={[
          {
            label: 'Nota de crédito',
            value: (
              <Link href={`/comprobantes/${r.creditNoteId}`} className={LINK_CLASSNAME}>
                {r.creditNoteNumber ?? 'Borrador'}
              </Link>
            ),
            detail: reason ?? undefined,
          },
          {
            label: 'Comprobante afectado',
            value:
              r.affectedDocumentId !== null ? (
                <Link href={`/comprobantes/${r.affectedDocumentId}`} className={LINK_CLASSNAME}>
                  {r.affectedDocumentNumber ?? 'Ver'}
                </Link>
              ) : (
                '—'
              ),
          },
          {
            label: 'Pedido',
            value: (
              <Link href={`/pedidos/${r.salesOrderId}`} className={LINK_CLASSNAME}>
                {r.salesOrderCode}
              </Link>
            ),
          },
          { label: 'Fecha', value: formatDate(r.operationDate), detail: 'La de la nota' },
        ]}
        total={
          showCost && r.totalCostPen !== null
            ? { label: 'Costo devuelto', value: formatMoney(r.totalCostPen) }
            : undefined
        }
      />

      {r.status === 'REVERSED' && (
        <Alert>
          <AlertDescription>
            Revertida por {r.reversedByName ?? '—'} el{' '}
            {r.reversedAt ? formatTimestampDate(r.reversedAt) : '—'}
            {r.reverseReason ? ` (${r.reverseReason})` : ''}. La mercadería volvió a salir del
            almacén al mismo costo.
          </AlertDescription>
        </Alert>
      )}

      <Section title="Qué volvió al almacén" count={r.items.length} empty="Sin líneas.">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Línea de la NC</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead>Material</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Reingresó al kardex</TableHead>
              {showCost && <TableHead className="text-right">Costo unitario</TableHead>}
              {showCost && <TableHead className="text-right">Costo total</TableHead>}
              <TableHead>Despacho</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((item) => (
              <TableRow key={item.lineNumber}>
                <TableCell>{item.lineNumber}</TableCell>
                <TableCell>{item.creditNoteLine}</TableCell>
                <TableCell>
                  <Link href={itemHref(item)} className={LINK_CLASSNAME}>
                    {item.description}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {item.itemType === 'COIL' ? 'Bobina' : 'Producto'}
                </TableCell>
                <TableCell className="text-right">
                  {formatQty(item.qty, unitSymbol(item.unit))}
                </TableCell>
                <TableCell className="text-right">
                  {formatQty(item.reserveQty, unitSymbol(item.kardexUnit))}
                </TableCell>
                {showCost && (
                  <TableCell className="text-right">
                    {item.unitCostPen !== null ? formatMoney(item.unitCostPen, 'PEN', 4) : '—'}
                  </TableCell>
                )}
                {showCost && (
                  <TableCell className="text-right">
                    {item.totalCostPen !== null ? formatMoney(item.totalCostPen) : '—'}
                  </TableCell>
                )}
                <TableCell>
                  <Link href={`/despachos/${item.dispatchId}`} className={LINK_CLASSNAME}>
                    {item.dispatchCode}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="text-xs text-muted-foreground">
        Registrada por {r.createdByName} el {formatTimestampDate(r.createdAt)}. Reingresó con la
        fecha de la nota y al costo con que salió en su despacho; se revierte anulando la nota de
        crédito.
      </div>
    </RoleGate>
  );
}
