'use client';

import { useQuery } from '@tanstack/react-query';
import type { ConfirmLineAction, ConfirmPreviewDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty, unitSymbol } from '@/lib/format';
import { formatExpiry } from '@/components/sales/temporary-reservation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ACTION_LABELS: Record<ConfirmLineAction, string> = {
  PRODUCE: 'Reserva MP y genera OP',
  RESERVE_STOCK: 'Reserva de stock',
  NONE: 'No reserva ni produce',
};

/**
 * D-186: confirmar es **un solo clic después de ver qué va a pasar**: qué se reserva, qué
 * órdenes salen con qué plan, qué líneas no generan nada. Si falta material el botón queda
 * apagado con el faltante dicho línea por línea (la confirmación bloquea, D-054).
 */
export function ConfirmQuotationDialog({
  quotationId,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  quotationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const preview = useQuery({
    queryKey: ['confirm-preview', quotationId],
    queryFn: () => api<ConfirmPreviewDto>(`/sales/quotations/${quotationId}/confirm-preview`),
    enabled: open,
    // Cada apertura vuelve a leer: el disponible pudo cambiar desde la última vez.
    staleTime: 0,
    gcTime: 0,
  });

  const data = preview.data;
  const blocked = !data || data.blockers.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Confirmar {data?.quotationCode ?? 'cotización'}</DialogTitle>
          <DialogDescription>
            En un solo paso: se crea el pedido, se reserva el material en firme y las líneas que se
            fabrican quedan con su orden de producción en cola.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : preview.isError || !data ? (
          <Alert variant="destructive">
            <AlertDescription>No se pudo calcular la vista previa.</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3">
            {data.temporaryReservationExpiresAt && (
              <p className="text-sm text-muted-foreground">
                La reserva temporal vigente (vence{' '}
                {formatExpiry(data.temporaryReservationExpiresAt)}) se convierte en firme.
              </p>
            )}
            <div className="max-h-[50vh] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead>Qué pasa</TableHead>
                    <TableHead>Reserva</TableHead>
                    <TableHead className="text-right">Disponible</TableHead>
                    <TableHead>Plan de corte</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((l) => (
                    <TableRow key={l.lineNumber} className="align-top">
                      <TableCell className="text-muted-foreground tabular-nums">
                        {l.lineNumber}
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal">
                        <div className="font-medium">{l.productSku}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatQty(l.qty, unitSymbol(l.unit))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={l.action === 'NONE' ? 'outline' : 'secondary'}>
                          {ACTION_LABELS[l.action]}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[14rem] text-xs whitespace-normal">
                        {l.reserveLabel ? (
                          <>
                            {l.reserveLabel}
                            <span className="block tabular-nums">
                              {formatQty(l.reserveQty ?? '0', unitSymbol(l.reserveUnit ?? ''))}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {l.availableQty === null ? (
                          '—'
                        ) : (
                          <span
                            className={l.shortfallQty ? 'font-medium text-destructive' : undefined}
                          >
                            {formatQty(l.availableQty, unitSymbol(l.reserveUnit ?? ''))}
                            {l.shortfallQty && (
                              <span className="block">
                                faltan {formatQty(l.shortfallQty, unitSymbol(l.reserveUnit ?? ''))}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[14rem] text-xs whitespace-normal">
                        {l.plan ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.blockers.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription>
                  <ul className="grid gap-1">
                    {data.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={blocked}
            pending={pending}
            pendingText="Confirmando…"
            onClick={() => {
              if (pending || blocked) return;
              onConfirm();
            }}
          >
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
