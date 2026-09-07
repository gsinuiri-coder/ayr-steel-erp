'use client';

import { useEffect, useState } from 'react';
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
import { OperationDateField } from '@/components/operation-date-field';

/**
 * Confirmación con motivo obligatorio. Toda anulación de Fase 2b (merma, partido,
 * bobina, compra) guarda el motivo en el kardex y en la auditoría (RF-95), así que la
 * UI no puede dejar confirmarla sin escribirlo. El API valida lo mismo: acá solo se
 * evita el viaje de ida y vuelta.
 *
 * D-124: con `withOperationDate` lleva además la fecha de operación de **la reversa**,
 * colapsada y solo para administradores. Es opt-in y no automático porque este diálogo lo
 * comparten dos clases de confirmación: las que escriben un hecho fechado (una anulación de
 * kardex, el cierre de una corrida) y las que solo cambian un estado (descartar una
 * cotización, dar de baja un comprobante ante el PSE, marcar prioridad en la cola). Mostrar
 * el campo en las segundas ofrecería mover una fecha que nadie guarda.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirmar',
  pending = false,
  withOperationDate = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  /** D-124: exponer la fecha de operación de la reversa (solo si el hecho queda fechado). */
  withOperationDate?: boolean;
  onConfirm: (reason: string, operationDate: string | undefined) => void;
}) {
  const [reason, setReason] = useState('');
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);

  // Ni el motivo ni la fecha se arrastran de una anulación a la siguiente: cada una tiene
  // los suyos, y una fecha pegada de la anterior es exactamente el error que nadie ve.
  useEffect(() => {
    if (open) {
      setReason('');
      setOperationDate(undefined);
    }
  }, [open]);

  const trimmed = reason.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="reason-input">Motivo</Label>
          <Input
            id="reason-input"
            value={reason}
            maxLength={240}
            placeholder="Por qué se anula"
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          {tooShort && (
            <p className="text-sm text-destructive">Explica el motivo en al menos 3 caracteres.</p>
          )}
          {withOperationDate && (
            <OperationDateField
              value={operationDate}
              onChange={setOperationDate}
              hint="Se registra con esta fecha, no con la de la operación que corrige."
            />
          )}
        </div>
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
            variant="destructive"
            disabled={pending || trimmed.length < 3}
            onClick={() => {
              onConfirm(trimmed, operationDate);
            }}
          >
            {pending ? 'Procesando…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
