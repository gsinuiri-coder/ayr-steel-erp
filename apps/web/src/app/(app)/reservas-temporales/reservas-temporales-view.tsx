'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Role, type TemporaryReservationListItemDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateSales } from '@/lib/sales-queries';
import { LINK_CLASSNAME } from '@/lib/utils';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import {
  formatExpiry,
  remainingLabel,
  TemporaryReservationLines,
} from '@/components/sales/temporary-reservation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/**
 * D-185: las reservas temporales vigentes — qué cotización, qué material, cuánto le queda — y
 * la liberación manual. Una vencida no aparece: la expiración es perezosa y el API ya la
 * cuenta como liberada.
 */
export function ReservasTemporalesView() {
  const queryClient = useQueryClient();
  const [releasing, setReleasing] = useState<TemporaryReservationListItemDto | null>(null);

  const list = useQuery({
    queryKey: ['temporary-reservations'],
    queryFn: () => api<TemporaryReservationListItemDto[]>('/sales/temporary-reservations'),
    // El tiempo restante cambia solo; se refresca cada minuto para no mentir sobre una que
    // venció mientras la pantalla estaba abierta.
    refetchInterval: 60_000,
  });

  const release = useMutation({
    mutationFn: ({ quotationId, reason }: { quotationId: string; reason: string }) =>
      api(`/sales/quotations/${quotationId}/release-reservation`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (_data, variables) => {
      toast.success('Reserva temporal liberada');
      setReleasing(null);
      invalidateSales(queryClient, { quotationId: variables.quotationId });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo liberar la reserva'),
  });

  return (
    <RoleGate allow={SALES_ROLES}>
      <div>
        <h1 className="text-lg font-semibold">Reservas temporales</h1>
        <p className="text-xs text-muted-foreground">
          Material apartado sobre cotizaciones emitidas mientras el cliente confirma. Descuenta
          disponible igual que un pedido y se libera solo al vencer.
        </p>
      </div>

      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.isError ? (
        <Alert variant="destructive">
          <AlertDescription>No se pudieron cargar las reservas temporales.</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Cotización</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Material apartado</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead>Queda</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((r) => (
                <TableRow key={r.quotationId} className="align-top">
                  <TableCell>
                    <Link href={`/cotizaciones/${r.quotationId}`} className={LINK_CLASSNAME}>
                      {r.quotationCode}
                    </Link>
                    <div className="text-xs text-muted-foreground">{r.createdByName ?? '—'}</div>
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">{r.customerName}</TableCell>
                  <TableCell className="whitespace-normal">
                    <TemporaryReservationLines lines={r.lines} />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatExpiry(r.expiresAt)}</TableCell>
                  <TableCell className="font-medium tabular-nums">
                    {remainingLabel(r.expiresAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={release.isPending}
                      onClick={() => {
                        if (release.isPending) return;
                        setReleasing(r);
                      }}
                    >
                      Liberar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {list.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No hay reservas temporales vigentes.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <ReasonDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null);
        }}
        title={`Liberar la reserva de ${releasing?.quotationCode ?? ''}`}
        description="El material vuelve a estar disponible. La cotización sigue emitida y se puede volver a reservar o confirmar."
        confirmLabel="Liberar reserva"
        pending={release.isPending}
        onConfirm={(reason) => {
          if (releasing) release.mutate({ quotationId: releasing.quotationId, reason });
        }}
      />
    </RoleGate>
  );
}
