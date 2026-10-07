'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import type { CoilDto, CoilRestorePlanDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/** D-375: la acción solo se ofrece sobre una bobina anulada que vino de una compra. */
export function canRestoreCoil(
  c: Pick<CoilDto, 'status' | 'purchaseId' | 'parentCoilId' | 'splitId'>,
): boolean {
  // Un fleje o una hija de partido/corte se restaura revirtiendo esa operación, no por acá.
  return (
    c.status === 'CANCELLED' &&
    c.purchaseId !== null &&
    c.parentCoilId === null &&
    c.splitId === null
  );
}

const MODE_TEXT: Record<CoilRestorePlanDto['mode'], string> = {
  EN_SU_FECHA: 'En su fecha (la de la anulación: como si nunca se hubiera anulado)',
  A_HOY: 'A hoy',
  BLOQUEADA: 'No se puede restaurar',
};

/**
 * D-375: restaurar una bobina anulada de compra. El modo (en su fecha o a hoy) lo decide el
 * API con el mismo clasificador que la ejecución; el modal solo lo muestra y pide el motivo.
 */
export function RestoreCoilDialog({
  coil,
  open,
  onOpenChange,
}: {
  coil: Pick<CoilDto, 'id' | 'code'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const plan = useQuery({
    queryKey: ['coil', coil.id, 'restore-plan'],
    queryFn: () => api<CoilRestorePlanDto>(`/coils/${coil.id}/restore-plan`),
    enabled: open,
    // El plan puede cambiar (otra pestaña, otro administrador): se pide de nuevo al abrir.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const restore = useMutation({
    mutationFn: (body: { reason: string }) =>
      api<CoilDto>(`/coils/${coil.id}/restore`, { method: 'POST', body }),
    onSuccess: () => {
      toast.success(`${coil.code} restaurada`);
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['coils'] });
      void queryClient.invalidateQueries({ queryKey: ['coil', coil.id] });
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'No se pudo restaurar'));
    },
  });

  const p = plan.data;
  const trimmed = reason.trim();
  const ready = p !== undefined && p.mode !== 'BLOQUEADA' && trimmed.length >= 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restaurar {coil.code}</DialogTitle>
          <DialogDescription>
            Vuelve a poner en stock esta misma bobina con la entrada de su compra. La compra no se
            modifica.
          </DialogDescription>
        </DialogHeader>
        {plan.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : p ? (
          <div className="grid gap-3" data-testid="restore-coil-plan">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Modo</dt>
              <dd className="font-medium">{MODE_TEXT[p.mode]}</dd>
              <dt className="text-muted-foreground">Fecha de la entrada</dt>
              <dd>{p.date ? formatDate(p.date) : '—'}</dd>
              <dt className="text-muted-foreground">Compra</dt>
              <dd>
                {p.purchaseDocument ?? '—'}
                {p.purchaseStatus === 'CANCELLED' ? ' (anulada)' : ''}
              </dd>
              <dt className="text-muted-foreground">Cantidad y costo</dt>
              <dd>
                {p.qty ? formatQty(p.qty, 'kg') : '—'} · {p.unitCostPen ?? '—'} PEN/kg
              </dd>
            </dl>
            {p.mode === 'A_HOY' && p.date && (
              <Alert>
                <AlertDescription>
                  La producción con esta bobina no puede tener fecha anterior a {formatDate(p.date)}
                  .{p.reasons.length > 0 ? ` (${p.reasons.join('; ')})` : ''}
                </AlertDescription>
              </Alert>
            )}
            {p.mode === 'BLOQUEADA' && (
              <Alert variant="destructive">
                <AlertDescription>{p.reasons.join('; ')}</AlertDescription>
              </Alert>
            )}
            {p.mode !== 'BLOQUEADA' && (
              <div className="grid gap-2">
                <Label htmlFor="restore-coil-reason">Motivo</Label>
                <Input
                  id="restore-coil-reason"
                  value={reason}
                  maxLength={240}
                  placeholder="Por qué se restaura"
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-destructive">No se pudo calcular la restauración.</p>
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
            disabled={!ready || restore.isPending}
            pending={restore.isPending}
            pendingText="Restaurando…"
            onClick={() => {
              if (!ready || restore.isPending) return;
              restore.mutate({ reason: trimmed });
            }}
          >
            Restaurar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
