'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Decimal, type CoilDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { isPositiveDecimal } from '@/lib/format';
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
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';

/**
 * Registrar merma sobre una bobina (RF-17). Es una salida `SCRAP` valorizada al costo
 * promedio vigente (D-040); anularla después es un movimiento inverso, no un borrado.
 */
export function CoilScrapDialog({
  coil,
  open,
  onOpenChange,
  onDone,
}: {
  coil: CoilDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [qtyKg, setQtyKg] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setQtyKg('');
      setReason('');
      setOperationDate(undefined);
    }
  }, [open]);

  // D-124: día de negocio de la merma, con su acuse de orden cronológico.
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  const scrap = useMutation({
    mutationFn: (confirmBackdate: boolean) =>
      api<CoilDto>(`/coils/${coil.id}/scrap`, {
        method: 'POST',
        body: {
          qtyKg: qtyKg.trim(),
          reason: reason.trim(),
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Merma registrada');
      onOpenChange(false);
      onDone();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar la merma'),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await scrap.mutateAsync(confirmBackdate);
  });

  const validQty = isPositiveDecimal(qtyKg);
  const exceeds = validQty && new Decimal(qtyKg.trim()).gt(new Decimal(coil.availableKg));
  const canSubmit = validQty && !exceeds && reason.trim().length >= 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar merma en {coil.code}</DialogTitle>
          <DialogDescription>
            Disponible: {coil.availableKg} kg. La merma sale al costo promedio vigente de la bobina
            y se puede anular después.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="scrap-qty">Kilos de merma</Label>
            <Input
              id="scrap-qty"
              inputMode="decimal"
              value={qtyKg}
              onChange={(e) => {
                setQtyKg(e.target.value);
              }}
            />
            {exceeds && (
              <p className="text-sm text-destructive">
                Supera el disponible de la bobina ({coil.availableKg} kg).
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="scrap-reason">Motivo</Label>
            <Input
              id="scrap-reason"
              maxLength={240}
              placeholder="Ej: borde oxidado, empalme defectuoso"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
        </div>

        <OperationDateField value={operationDate} onChange={setOperationDate} />

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
            disabled={!canSubmit || scrap.isPending}
            onClick={() => {
              void backdate.attempt();
            }}
          >
            {scrap.isPending ? 'Registrando…' : 'Registrar merma'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={scrap.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />
    </Dialog>
  );
}
