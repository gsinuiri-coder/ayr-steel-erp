'use client';

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
 * D-347/M6 — borrado físico de un producto que nunca se usó.
 *
 * Distinto de «Desactivar»: esto **no tiene reversa**. El backend ya solo deja llegar acá un
 * SKU sin historia detrás (`canDelete`, revalidado igual al confirmar), pero la confirmación
 * nombra el SKU para que quien borra sepa exactamente cuál está por desaparecer.
 */
export function DeleteProductDialog({
  open,
  onOpenChange,
  sku,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Borrar {sku} del catálogo</DialogTitle>
          <DialogDescription>
            Esto borra el producto {sku} para siempre: no queda como inactivo, no se puede deshacer.
            Solo se puede borrar porque nunca se usó (sin kardex, sin cotizaciones, pedidos, compras
            ni comprobantes detrás).
          </DialogDescription>
        </DialogHeader>
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
            disabled={pending}
            pending={pending}
            pendingText="Borrando…"
            onClick={() => {
              if (pending) return;
              onConfirm();
            }}
          >
            Borrar {sku}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
