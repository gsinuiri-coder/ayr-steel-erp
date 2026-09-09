'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Decimal, type CoilDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatQty } from '@/lib/format';
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
 * Cerrar una bobina con saldo (RF-19, **D-164**): el remanente se liquida como movimiento de
 * kardex en la misma transacción que el cierre.
 *
 * El diálogo existe para que la baja de inventario **no ocurra por defecto**. Antes de D-164
 * cerrar era un botón sin pregunta y el saldo teórico se quedaba en el valorizado para
 * siempre; ahora se muestra lo que se va a liquidar —kilos y soles, con el mismo promedio con
 * el que el kardex lo va a sacar— y se pide el motivo, igual que cualquier otra merma (RF-17).
 *
 * El campo que se tipea es **cuántos kilos quedan de verdad**, no cuántos se dan de baja: es
 * lo que planta puede ver mirando el rollo. La liquidación es la diferencia, y por eso el
 * mismo diálogo cubre los dos sentidos —el rollo agotado que deja saldo teórico (lo normal) y
 * el conteo que da de más que el kardex (que da de alta material)— sin un segundo formulario.
 */
export function CoilCloseDialog({
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
  const [physicalKg, setPhysicalKg] = useState('');
  const [reason, setReason] = useState('');
  // D-124: día de negocio del cierre y de su ajuste, con su acuse de orden cronológico.
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      // Arranca **vacío**, no en cero. El API rechaza a propósito un default de cero —«un
      // olvido no puede ser una baja de inventario silenciosa»— y prellenar el campo con la
      // baja total lo reintroducía por la ventana: sobre un rollo de 5 000 kg alcanzaba con
      // tipear un motivo y confirmar. El número lo declara la persona, siempre.
      setPhysicalKg('');
      setReason('');
      setOperationDate(undefined);
    }
  }, [open]);

  const balance = new Decimal(coil.availableKg);
  const avgCost = new Decimal(coil.avgCostPen);
  // La coma decimal se normaliza a punto **y es `typed` lo que se manda**, no el texto crudo:
  // mandar el crudo hacía que `12,5` pasara la validación de la pantalla, mostrara la
  // liquidación y después rebotara con un 400 del schema de Zod. Es el mismo defecto de D-163
  // —la pantalla prometiendo un número que el API rechaza—, en el campo de al lado.
  //
  // Un campo vacío es "todavía no tipeó" y no cero: sin eso, borrarlo mostraba de golpe que se
  // liquidan los kilos enteros. El tope de tres decimales es la escala de kilos (D-003): con
  // más, la pantalla mostraba una liquidación y el API redondeaba y movía otra.
  const typed = physicalKg.trim().replace(',', '.');
  const validPhysical = typed !== '' && /^\d+(\.\d{1,3})?$/.test(typed);
  const physical = validPhysical ? new Decimal(typed) : null;
  const difference = physical === null ? null : balance.minus(physical);
  const liquidatedKg = difference === null ? null : difference.abs().toDecimalPlaces(3);
  const isSurplus = difference?.isNegative() ?? false;
  const liquidates = liquidatedKg?.gt(0) ?? false;
  // El mismo promedio con el que el kardex la va a valorizar. Sobre un saldo en cero no hay
  // promedio vigente y el API cae al costo del documento, que la pantalla no conoce: por eso
  // el sobrante solo muestra soles cuando hay saldo, y ahí el número sí es el que se va a
  // mover. Prometer un valor que el API calcula de otra fuente es el defecto de D-163.
  const liquidatedPen = liquidatedKg === null ? null : liquidatedKg.times(avgCost);
  const showsPen = !isSurplus || balance.gt(0);
  const canSubmit = validPhysical && (!liquidates || reason.trim().length >= 3);
  // Un rollo no puede tener más kilos de los que entraron: el API lo rechaza y la pantalla lo
  // dice antes, en vez de dejar tipear y rebotar.
  const exceedsIntake = physical?.gt(new Decimal(coil.weightKg)) ?? false;

  const close = useMutation({
    mutationFn: (confirmBackdate: boolean) =>
      api<CoilDto>(`/coils/${coil.id}/status`, {
        method: 'POST',
        body: {
          status: 'CLOSED',
          physicalKg: typed,
          reason: reason.trim() || undefined,
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Bobina cerrada');
      onOpenChange(false);
      onDone();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cerrar la bobina'),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await close.mutateAsync(confirmBackdate);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cerrar {coil.code}</DialogTitle>
          <DialogDescription>
            El kardex tiene {formatQty(coil.availableKg, 'kg')} de saldo, valorizados en{' '}
            {formatMoney(balance.times(avgCost).toFixed(4))}. Al cerrar, la diferencia contra lo que
            quede de verdad se liquida como movimiento de kardex (D-164).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="close-physical">Kilos que quedan en el rollo</Label>
            <Input
              id="close-physical"
              inputMode="decimal"
              value={physicalKg}
              aria-invalid={(!validPhysical && physicalKg.trim() !== '') || exceedsIntake}
              aria-describedby="close-physical-help"
              onChange={(e) => {
                setPhysicalKg(e.target.value);
              }}
            />
            <div id="close-physical-help">
              {!validPhysical && physicalKg.trim() !== '' && (
                <p className="text-sm text-destructive">
                  Escribe los kilos que quedan, sin signo y con hasta tres decimales.
                </p>
              )}
              {exceedsIntake && (
                <p className="text-sm text-destructive">
                  La bobina entró con {formatQty(coil.weightKg, 'kg')}: no puede quedarle más.
                </p>
              )}
            </div>
          </div>

          {liquidatedKg !== null && liquidatedPen !== null && (
            <div aria-live="polite" className="rounded-md border bg-muted/40 p-3 text-sm">
              {liquidates ? (
                <p>
                  {isSurplus ? (
                    <>
                      Entran <strong>{formatQty(liquidatedKg.toFixed(3), 'kg')}</strong> al kardex
                      {showsPen && <> por {formatMoney(liquidatedPen.toFixed(4))}</>}: el conteo da
                      más que el saldo teórico. Da de alta material, así que el motivo es
                      obligatorio.
                    </>
                  ) : (
                    <>
                      Se liquidan <strong>{formatQty(liquidatedKg.toFixed(3), 'kg')}</strong> como
                      merma, <strong>{formatMoney(liquidatedPen.toFixed(4))}</strong> de menos en el
                      inventario valorizado.
                    </>
                  )}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  No se liquida nada: la bobina se cierra conservando su saldo y deja de estar
                  disponible para producción y partido.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-1">
            <Label htmlFor="close-reason">Motivo{liquidates ? '' : ' (opcional)'}</Label>
            <Input
              id="close-reason"
              maxLength={240}
              placeholder="Ej: el rollo se terminó en la corrida del martes"
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
            disabled={!canSubmit || exceedsIntake || close.isPending}
            onClick={() => {
              void backdate.attempt();
            }}
          >
            {close.isPending ? 'Cerrando…' : 'Cerrar bobina'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={close.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />
    </Dialog>
  );
}
