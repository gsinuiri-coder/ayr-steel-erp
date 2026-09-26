'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CoilDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
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

export type FilmDialogMode = 'open' | 'reseal';

/**
 * D-328: «Abrir bobina» (quitarle el film para empezar a usarla) y «Volver a sellar» (se abrió
 * por error y no se usó). Ninguna mueve kardex ni cambia el estado de la bobina: es un hecho
 * fechado (D-124) con motivo opcional. Si volver a sellar no procede —salió material, está
 * montada en una OP— el API contesta con el movimiento o la OP que lo impide y este diálogo lo
 * muestra tal cual.
 */
export function CoilFilmDialog({
  coil,
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  coil: CoilDto;
  mode: FilmDialogMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setReason('');
      setOperationDate(undefined);
    }
  }, [open]);

  const trimmed = reason.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 3;
  const opening = mode === 'open';

  const run = useMutation({
    mutationFn: () =>
      api<CoilDto>(`/coils/${coil.id}/film/${mode}`, {
        method: 'POST',
        body: { reason: trimmed || undefined, operationDate },
      }),
    onSuccess: () => {
      toast.success(opening ? 'Bobina abierta' : 'Bobina vuelta a sellar');
      onOpenChange(false);
      onDone();
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.message
          : opening
            ? 'No se pudo abrir la bobina'
            : 'No se pudo volver a sellar la bobina',
      ),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {opening ? 'Abrir' : 'Volver a sellar'} {coil.code}
          </DialogTitle>
          <DialogDescription>
            {opening
              ? 'Se le quita el film de protección para empezar a usarla. No mueve el kardex ni cambia su estado.'
              : 'Solo si se abrió por error y todavía no se usó: no puede haber salido material desde que se abrió ni estar montada en una orden de producción.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1">
          <Label htmlFor="film-reason">Motivo (opcional)</Label>
          <Input
            id="film-reason"
            maxLength={240}
            placeholder={
              opening ? 'Ej: se abre para la corrida de mañana' : 'Ej: se abrió por error'
            }
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          {tooShort && (
            <p className="text-sm text-destructive">Explica el motivo en al menos 3 caracteres.</p>
          )}
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
            disabled={tooShort || run.isPending}
            pending={run.isPending}
            pendingText="Procesando…"
            onClick={() => {
              if (tooShort || run.isPending) return;
              run.mutate();
            }}
          >
            {opening ? 'Abrir bobina' : 'Volver a sellar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
