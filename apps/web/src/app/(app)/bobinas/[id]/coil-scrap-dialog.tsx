'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import { Decimal, type CoilDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatKgPrecise, formatMoney, isPositiveDecimal } from '@/lib/format';
import { composeReason, OTHER_REASON, SCRAP_REASONS } from '@/lib/reasons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, InputWithUnit } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { FilmOpenNotice } from '@/components/film-open-notice';
import { OperationDateField } from '@/components/operation-date-field';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';

/**
 * Registrar merma sobre una bobina (RF-17). Es una salida `SCRAP` valorizada al costo
 * promedio vigente (D-040); anularla después es un movimiento inverso, no un borrado.
 *
 * cc31 (ESPEC §6, el diálogo modelo): título con el verbo y la bobina, kilos con su unidad
 * adentro, motivo de lista con detalle aparte, el bloque «Qué va a pasar» con las cifras y el
 * botón que repite el título, en rojo porque saca inventario. Lo que viaja al API sigue siendo el
 * texto del motivo (`composeReason`).
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
  const [choice, setChoice] = useState('');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (open) {
      setQtyKg('');
      setChoice('');
      setDetail('');
      setOperationDate(undefined);
    }
  }, [open]);

  const reason = composeReason(choice || (detail.trim() ? OTHER_REASON : ''), detail);

  // D-124: día de negocio de la merma, con su acuse de orden cronológico.
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  const scrap = useMutation({
    mutationFn: (confirmBackdate: boolean) =>
      api<CoilDto>(`/coils/${coil.id}/scrap`, {
        method: 'POST',
        body: {
          qtyKg: qtyKg.trim(),
          reason,
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
        },
      }),
    onSuccess: () => {
      toast.success(`Merma registrada en ${coil.code}`, {
        description: `Salieron ${formatKgPrecise(qtyKg.trim())} de la bobina.`,
      });
      onOpenChange(false);
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo registrar la merma')),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await scrap.mutateAsync(confirmBackdate);
  });

  const validQty = isPositiveDecimal(qtyKg);
  const qty = validQty ? new Decimal(qtyKg.trim()) : null;
  const available = new Decimal(coil.availableKg);
  const exceeds = qty?.gt(available) ?? false;
  const canSubmit = qty !== null && !exceeds && reason.length >= 3;
  // «Sale del inventario»: los kilos al costo promedio vigente (D-040), como lo valoriza el API.
  // Sin costo a la vista (el API lo oculta a quien no lo ve) no se inventa un valor.
  const value = qty === null || coil.avgCostPen === null ? null : qty.times(coil.avgCostPen);

  function submit() {
    if (!canSubmit || scrap.isPending) return;
    void backdate.attempt();
  }

  const title = `Registrar merma · ${coil.code}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              La merma sale al costo promedio vigente de la bobina y se puede anular después.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="scrap-qty">Kilos de merma</Label>
              <InputWithUnit
                id="scrap-qty"
                unit="kg"
                inputMode="decimal"
                value={qtyKg}
                aria-invalid={exceeds || undefined}
                onChange={(e) => {
                  setQtyKg(e.target.value);
                }}
              />
              {exceeds && (
                <p className="text-sm text-destructive">
                  Supera el disponible de la bobina ({formatKgPrecise(coil.availableKg)}): escribe
                  una cifra menor.
                </p>
              )}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="scrap-reason-choice">Motivo</Label>
              <Select value={choice} onValueChange={setChoice}>
                <SelectTrigger id="scrap-reason-choice" className="w-full">
                  <SelectValue placeholder="Elige el motivo" />
                </SelectTrigger>
                <SelectContent>
                  {SCRAP_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="scrap-reason">
                Detalle
                {choice !== OTHER_REASON && (
                  <span className="font-normal text-muted-foreground"> · opcional</span>
                )}
              </Label>
              <Input
                id="scrap-reason"
                maxLength={200}
                value={detail}
                onChange={(e) => {
                  setDetail(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Por ejemplo: golpe de montacargas en la cola.
              </p>
            </div>
          </div>

          <FilmOpenNotice coils={[coil]} />

          <div className="grid gap-1 rounded-lg bg-muted px-3 py-2">
            <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
              <dt className="text-muted-foreground">Saldo de la bobina</dt>
              <dd className="text-right">
                {formatKgPrecise(available)}
                {qty !== null && !exceeds && <> → {formatKgPrecise(available.minus(qty))}</>}
              </dd>
              <dt className="text-muted-foreground">Sale del inventario</dt>
              <dd className="text-right">
                {value === null || exceeds ? '—' : formatMoney(value.toFixed(4))}
              </dd>
            </dl>
          </div>

          <OperationDateField value={operationDate} onChange={setOperationDate} />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!canSubmit || scrap.isPending}
              pending={scrap.isPending}
              pendingText="Registrando…"
            >
              Registrar merma
            </Button>
          </DialogFooter>
        </form>
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
