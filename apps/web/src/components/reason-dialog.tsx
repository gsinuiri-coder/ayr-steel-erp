'use client';

import { useEffect, useState, type ReactNode } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OperationDateField } from '@/components/operation-date-field';
import { composeReason, OTHER_REASON } from '@/lib/reasons';

/**
 * Confirmación con motivo obligatorio. Toda anulación de Fase 2b (merma, partido,
 * bobina, compra) guarda el motivo en el kardex y en la auditoría (RF-95), así que la
 * UI no puede dejar confirmarla sin escribirlo. El API valida lo mismo: aquí solo se
 * evita el viaje de ida y vuelta.
 *
 * D-124: con `withOperationDate` lleva además la fecha de operación de **la reversa**,
 * colapsada y solo para administradores. Es opt-in y no automático porque este diálogo lo
 * comparten dos clases de confirmación: las que escriben un hecho fechado (una anulación de
 * kardex, el cierre de una corrida) y las que solo cambian un estado (descartar una
 * cotización, dar de baja un comprobante ante el PSE, marcar prioridad en la cola). Mostrar
 * el campo en las segundas ofrecería mover una fecha que nadie guarda.
 *
 * cc31 (ESPEC §6): con `reasons`, el motivo se elige de una lista y el detalle es opcional
 * («Otro» exige el detalle); lo que viaja al API sigue siendo un texto, armado con
 * `composeReason`. `consequences` es el bloque fijo «Qué va a pasar». El ejemplo va debajo del
 * campo, no como texto fantasma adentro. Enter confirma.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirmar',
  pending = false,
  withOperationDate = false,
  placeholder = 'Por qué se anula',
  constructive = false,
  reasons,
  consequences,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  /** El ejemplo del campo (se muestra debajo); por defecto el de una anulación. */
  placeholder?: string;
  /** La acción no destruye nada (p. ej. completar una reserva): el botón no va en rojo. */
  constructive?: boolean;
  /** D-124: exponer la fecha de operación de la reversa (solo si el hecho queda fechado). */
  withOperationDate?: boolean;
  /** cc31: los motivos de la lista; sin ella, el motivo se escribe. */
  reasons?: readonly string[];
  /** cc31: «Qué va a pasar», con cifras. */
  consequences?: ReactNode;
  onConfirm: (reason: string, operationDate: string | undefined) => void;
}) {
  const [choice, setChoice] = useState('');
  const [detail, setDetail] = useState('');
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);

  // Ni el motivo ni la fecha se arrastran de una anulación a la siguiente: cada una tiene
  // los suyos, y una fecha pegada de la anterior es exactamente el error que nadie ve.
  useEffect(() => {
    if (open) {
      setChoice('');
      setDetail('');
      setOperationDate(undefined);
    }
  }, [open]);

  const withList = reasons !== undefined && reasons.length > 0;
  // Un detalle escrito sin elegir motivo cuenta como «Otro»: el texto es el detalle.
  const effectiveChoice = choice || (detail.trim() ? OTHER_REASON : '');
  const text = withList ? composeReason(effectiveChoice, detail) : detail.trim();
  const needsDetail = withList && effectiveChoice === OTHER_REASON;
  const typedTooShort = detail.trim().length > 0 && detail.trim().length < 3;
  const tooShort = withList ? needsDetail && typedTooShort : typedTooShort;
  const ready = !pending && text.length >= 3;

  function confirm() {
    // F8-S1/M1: el `disabled` cubre el clic normal, pero no un doble Enter disparado antes de
    // que React repinte el DOM: este guard evalúa el estado actual en el momento del envío.
    if (!ready) return;
    onConfirm(text, operationDate);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {withList && (
              <>
                <Label htmlFor="reason-choice">Motivo</Label>
                <Select value={choice} onValueChange={setChoice}>
                  <SelectTrigger id="reason-choice" className="w-full">
                    <SelectValue placeholder="Elige el motivo" />
                  </SelectTrigger>
                  <SelectContent>
                    {reasons.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <Label htmlFor="reason-input">
              {withList ? 'Detalle' : 'Motivo'}
              {withList && !needsDetail && (
                <span className="font-normal text-muted-foreground"> · opcional</span>
              )}
            </Label>
            <Input
              id="reason-input"
              value={detail}
              maxLength={200}
              onChange={(e) => {
                setDetail(e.target.value);
              }}
            />
            {!withList && (
              <p className="text-xs text-muted-foreground">Por ejemplo: {placeholder}.</p>
            )}
            {tooShort && (
              <p className="text-sm text-destructive">
                Explica el motivo en al menos 3 caracteres.
              </p>
            )}
            {withOperationDate && (
              <OperationDateField
                value={operationDate}
                onChange={setOperationDate}
                hint="Se registra con esta fecha, no con la de la operación que corrige."
              />
            )}
          </div>
          {consequences && (
            <div className="grid gap-1 rounded-lg bg-muted px-3 py-2">
              <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
              {consequences}
            </div>
          )}
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
              variant={constructive ? 'default' : 'destructive'}
              disabled={!ready}
              pending={pending}
              pendingText="Procesando…"
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
