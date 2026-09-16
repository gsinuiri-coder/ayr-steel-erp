'use client';

import { useQuery } from '@tanstack/react-query';
import {
  money,
  salePriceFromValue,
  toFixedString,
  type ProductListPriceChangeDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function formatChangedAt(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Con IGV (D-162), lo que el dueño lee. `null` = sin precio de lista. */
function priceLabel(valuePen: string | null): string {
  if (valuePen === null) return 'sin precio';
  return formatMoney(toFixedString(money(salePriceFromValue(valuePen)), 'MONEY'));
}

/** D-217/M1: historial de un SKU, mismo criterio de presentación que `PriceChangesCard` (D-187). */
export function PriceListHistoryDialog({
  productId,
  productSku,
  open,
  onOpenChange,
}: {
  productId: string;
  productSku: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const changes = useQuery({
    queryKey: ['catalog', 'price-list-changes', productId],
    queryFn: () =>
      api<ProductListPriceChangeDto[]>(`/catalog/price-list/changes?productId=${productId}`),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Historial de precio — {productSku}</DialogTitle>
        </DialogHeader>
        {changes.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : changes.data && changes.data.length > 0 ? (
          <Table aria-label="Historial de precio de lista">
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead className="text-right">Antes</TableHead>
                <TableHead className="text-right">Después</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="tabular-nums">{formatChangedAt(c.changedAt)}</TableCell>
                  <TableCell>{c.changedByName}</TableCell>
                  <TableCell>
                    <Badge variant={c.origin === 'IMPORT' ? 'secondary' : 'outline'}>
                      {c.origin === 'IMPORT' ? 'Carga masiva' : 'Edición'}
                      {c.revertsBatchId !== null ? ' (reversa)' : ''}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(c.beforeValuePen)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(c.afterValuePen)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">Sin cambios de precio registrados.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
