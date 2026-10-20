'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { businessToday, type FiscalDocumentDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { errorMessage, toast } from '@/lib/notify';
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * cc61 (D-699): pone o corrige el vencimiento de un comprobante al crédito. Solo ADMINISTRADOR (lo
 * decide quien lo abre y lo exige el API). La fecha propuesta es el vencimiento actual o, si no
 * tiene, el día de hoy en Lima; no puede ser anterior a la emisión. El motivo es opcional.
 */
export function DueDateDialog({
  document: d,
  open,
  onOpenChange,
  onDone,
}: {
  document: FiscalDocumentDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [prevOpen, setPrevOpen] = useState(false);
  // Al abrir, parte del vencimiento vigente (o de hoy en Lima) y sin motivo.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setDueDate(d.dueDate ?? businessToday());
      setReason('');
    }
  }

  const save = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${d.id}/due-date`, {
        method: 'PATCH',
        body: { dueDate, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: (updated) => {
      toast.success(
        `Vencimiento actualizado: ${updated.dueDate ? formatDate(updated.dueDate) : 'sin vencimiento'}`,
      );
      onOpenChange(false);
      onDone();
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'No se pudo cambiar el vencimiento'));
    },
  });

  const valid = ISO_DATE.test(dueDate) && dueDate >= d.issueDate && dueDate !== d.dueDate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambiar el vencimiento</DialogTitle>
          <DialogDescription>
            La fecha en que vence la cuenta por cobrar de este comprobante al crédito. No puede ser
            anterior a la emisión ({formatDate(d.issueDate)}).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="new-due-date">Vencimiento</Label>
          <Input
            id="new-due-date"
            type="date"
            min={d.issueDate}
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value);
            }}
          />
          <p className="text-sm text-muted-foreground">
            Actual:{' '}
            <span className="font-medium">
              {d.dueDate ? formatDate(d.dueDate) : 'sin vencimiento'}
            </span>
            .
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="due-date-reason">Motivo (opcional)</Label>
          <Input
            id="due-date-reason"
            autoComplete="off"
            placeholder="Se registró sin vencimiento"
            maxLength={200}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
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
            disabled={!valid || save.isPending}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              if (save.isPending) return;
              save.mutate();
            }}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
