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

/**
 * Confirmación con motivo obligatorio. Toda anulación de Fase 2b (merma, partido,
 * bobina, compra) guarda el motivo en el kardex y en la auditoría (RF-95), así que la
 * UI no puede dejar confirmarla sin escribirlo. El API valida lo mismo: acá solo se
 * evita el viaje de ida y vuelta.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirmar',
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  // El motivo no se arrastra de una anulación a la siguiente: cada una tiene el suyo.
  useEffect(() => {
    if (open) setReason('');
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
              onConfirm(trimmed);
            }}
          >
            {pending ? 'Procesando…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
