'use client';

import { useEffect, useRef } from 'react';
import {
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  sum,
  toDecimal,
  type PlantClosePreviewDto,
} from '@ayr/shared';
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
  mountedKg,
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
  /**
   * cc29 (M3, D-469): los kilos montados en la orden (coberturas). Con ellos, si el despunte pasa
   * del 10 % de lo montado, el diálogo pregunta si el material sigue en el almacén para otra OP.
   * Drywall no lo pasa: el fleje entra entero a la perfiladora.
   */
  mountedKg?: string;
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
  // cc29 (M3): lo que vuelve al almacén es el saldo que les queda a las bobinas que no se terminan.
  const backToStock = preview === null ? null : sum(preview.coils.map((c) => c.balanceAfterKg));
  const highScrap =
    scrap !== null &&
    mountedKg !== undefined &&
    toDecimal(mountedKg).gt(0) &&
    scrap.gt(toDecimal(mountedKg).times(MAX_SCRAP_RATIO_WITHOUT_REASON));

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

            {highScrap && (
              <div
                role="alert"
                data-testid="aviso-sigue-en-almacen"
                className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5"
              >
                <span className="font-medium">¿Sigue en el almacén para otra OP?</span> El{' '}
                {scrapLabel.toLowerCase()} pasa del {String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} %
                de lo montado ({formatQty(mountedKg ?? '0.000', 'kg')}). Si el material está entero,
                vuelve y declara menos kilos consumidos: lo que no se consume vuelve al almacén en
                vez de salir como {scrapLabel.toLowerCase()}.
              </div>
            )}

            <ul className="grid gap-1">
              <li>
                Vuelve al almacén:{' '}
                <span className="font-medium" data-testid="vuelve-al-almacen">
                  {backToStock?.gt(0) ? formatQty(backToStock.toFixed(3), 'kg') : 'nada'}
                </span>
              </li>
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
