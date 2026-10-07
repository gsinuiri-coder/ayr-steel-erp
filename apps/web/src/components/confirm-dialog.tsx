'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * cc31 (ESPEC §6): confirmación simple, sin motivo. El título lleva el verbo y el nombre de lo
 * que se toca («Desactivar a Juan Pérez»), el bloque fijo «Qué va a pasar» lo dice en una línea
 * y el botón repite el título; en rojo salvo que la acción sea constructiva.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequences,
  description,
  confirmLabel,
  constructive = false,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** «Qué va a pasar», en una línea. */
  consequences: ReactNode;
  /** Texto bajo el título; opcional. */
  description?: ReactNode;
  /** Por defecto repite el título. */
  confirmLabel?: string;
  constructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-1 rounded-lg bg-muted px-3 py-2">
          <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
          <p className="text-sm">{consequences}</p>
        </div>
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
            type="button"
            variant={constructive ? 'default' : 'destructive'}
            disabled={pending}
            pending={pending}
            pendingText="Procesando…"
            onClick={() => {
              // Mismo guard que ReasonDialog: un doble Enter llega antes del repintado.
              if (pending) return;
              onConfirm();
            }}
          >
            {confirmLabel ?? title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
