'use client';

import { useEffect, useRef } from 'react';
import { toDecimal, type PlantClosePreviewDto } from '@ayr/shared';
import { formatQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * cc27 (UX26-03, D-453): la confirmación de una acción de planta que **cierra una orden** en un
 * clic —mueve kardex, suelta despunte o merma y puede terminar bobinas—.
 *
 * Todo lo que muestra lo calculó el API corriendo la misma acción en una transacción que se
 * deshace (`…/preview`); el web no cuenta un kilo. «Volver» tiene el foco: un Enter de más no
 * ejecuta nada. Sin palabra tipeada ni casilla: el resumen es la confirmación.
 */
export function ClosePreviewDialog({
  preview,
  title,
  confirmLabel,
  pending,
  scrapLabel = 'Despunte del cierre',
  onConfirm,
  onCancel,
}: {
  /** El resumen del API; `null` cierra el diálogo. */
  preview: PlantClosePreviewDto | null;
  title: string;
  confirmLabel: string;
  pending: boolean;
  /** «Despunte» en coberturas (D-089), «Merma de proceso» en drywall (D-057). */
  scrapLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  // Un doble clic antes de que React repinte el botón deshabilitado no ejecuta dos veces.
  const fired = useRef(false);
  useEffect(() => {
    if (preview !== null) fired.current = false;
  }, [preview]);

  const terminated = preview?.coils.filter((c) => c.terminated) ?? [];
  const scrap = preview === null ? null : toDecimal(preview.scrapKg);

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          backRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Esto es lo que va a quedar en el kardex al confirmar. Revísalo antes de seguir: la orden{' '}
            {preview?.orderCode} queda cerrada.
          </DialogDescription>
        </DialogHeader>

        {preview !== null && (
          <div className="grid gap-3 text-sm">
            <Table aria-label="Consumo por bobina">
              <TableHeader>
                <TableRow>
                  <TableHead>Bobina</TableHead>
                  <TableHead className="text-right">Saldo actual</TableHead>
                  <TableHead className="text-right">kg a consumir</TableHead>
                  <TableHead className="text-right">Saldo resultante</TableHead>
                  <TableHead>Queda</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.coils.map((c) => (
                  <TableRow key={c.coilId}>
                    <TableCell className="font-mono">{c.coilCode}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(c.balanceBeforeKg, 'kg')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatQty(c.consumedKg, 'kg')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(c.balanceAfterKg, 'kg')}
                    </TableCell>
                    <TableCell>{c.terminated ? 'Terminada' : 'Vuelve al almacén'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ul className="grid gap-1">
              <li>
                {scrapLabel}:{' '}
                <span className="font-medium">
                  {scrap?.gt(0) ? formatQty(preview.scrapKg, 'kg') : 'ninguno'}
                </span>
              </li>
              <li>
                Bobinas que quedan terminadas:{' '}
                <span className="font-medium">
                  {terminated.length === 0
                    ? 'ninguna'
                    : terminated.map((c) => c.coilCode).join(', ')}
                </span>
              </li>
            </ul>

            {preview.outOfTolerance.length > 0 && (
              <div
                role="alert"
                className="grid gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5"
              >
                <span className="font-medium">
                  Fuera de tolerancia (se registra con la casilla)
                </span>
                {preview.outOfTolerance.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            )}
            {preview.warnings.length > 0 && (
              <div className="grid gap-1 text-muted-foreground">
                {preview.warnings.map((w) => (
                  <span key={w}>⚠ {w}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button ref={backRef} variant="outline" disabled={pending} onClick={onCancel}>
            Volver
          </Button>
          <Button
            pending={pending}
            pendingText="Cerrando…"
            onClick={() => {
              if (pending || fired.current) return;
              fired.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
