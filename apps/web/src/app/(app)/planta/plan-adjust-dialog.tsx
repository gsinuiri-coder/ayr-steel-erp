'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  checkRoofingPlanAdjustment,
  piecesMeters,
  toDecimal,
  Unit,
  type PieceLike,
  type ProductionOrderDto,
  type RoofingBatchOrderDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { errorMessage, toast } from '@/lib/notify';
import { metersToMm, mmToMeters, parsePieceRows, type PieceRow } from '@/lib/pieces';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * cc35 (ESPEC §3) — «Ajustar el plan» de una orden de coberturas, en un diálogo.
 *
 * Una fila por largo: largo y planchas editables, las ya reportadas, sus metros y «Quitar». El
 * total tiene que dar **los mismos metros** del plan vigente (a medida, D-545): la franja lo dice
 * en verde o en rojo, y con rojo el plan no se guarda. Un largo con planchas reportadas no baja de
 * ese número ni se quita (D-546). La regla es `checkRoofingPlanAdjustment`, la misma del API.
 *
 * En una plancha de catálogo el largo lo trae el SKU: solo se cambia la cantidad, y el total puede
 * cambiar (D-545).
 *
 * «Guardar el plan» no se apaga (estándar de formularios de cc31): con el plan sin cuadrar, al
 * pulsarlo se queda y lo dice.
 */

/** Planchas reportadas por largo (clave en mm con dos decimales), sacadas del plan y lo que falta. */
export function reportedByLength(order: RoofingBatchOrderDto): Map<string, number> {
  const planned = new Map<string, number>();
  for (const p of order.planItems) {
    const key = toDecimal(p.lengthMm).toFixed(2);
    planned.set(key, (planned.get(key) ?? 0) + p.qty);
  }
  const left = new Map<string, number>();
  for (const p of order.remainingPieces) {
    const key = toDecimal(p.lengthMm).toFixed(2);
    left.set(key, (left.get(key) ?? 0) + p.qty);
  }
  const reported = new Map<string, number>();
  for (const [key, qty] of planned) reported.set(key, qty - (left.get(key) ?? 0));
  return reported;
}

/** El plan es de metros exactos: cobertura a medida (`detailsLengths`). */
export function planNeedsExactMeters(order: RoofingBatchOrderDto): boolean {
  return order.productUnit === Unit.MTR && !order.isAccessory;
}

function keyOf(lengthM: string): string | null {
  const raw = lengthM.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(raw)) return null;
  return metersToMm(raw);
}

interface PlanSummary {
  lines: string[];
}

/** «Qué va a pasar»: qué largos cambian de cantidad, cuáles se agregan y cuáles se quitan. */
function summarize(current: readonly PieceLike[], next: readonly RoofingPieceDto[]): PlanSummary {
  const before = new Map<string, number>();
  for (const p of current) {
    const key = toDecimal(p.lengthMm).toFixed(2);
    before.set(key, (before.get(key) ?? 0) + p.qty);
  }
  const after = new Map<string, number>();
  for (const p of next) {
    const key = toDecimal(p.lengthMm).toFixed(2);
    after.set(key, (after.get(key) ?? 0) + p.qty);
  }
  const m = (key: string) => `${toDecimal(key).div(1000).toFixed(2)} m`;
  const lines: string[] = [];
  for (const [key, qty] of before) {
    const now = after.get(key);
    if (now === undefined) lines.push(`Se quita ${m(key)} × ${String(qty)}.`);
    else if (now !== qty) {
      lines.push(`${m(key)} pasa de ${String(qty)} a ${String(now)} planchas.`);
    }
  }
  for (const [key, qty] of after) {
    if (!before.has(key)) lines.push(`Se agrega ${m(key)} × ${String(qty)}.`);
  }
  return { lines };
}

export function PlanAdjustDialog({
  order,
  open,
  onOpenChange,
  addLengthM,
  onSaved,
}: {
  order: RoofingBatchOrderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** «+ Otro largo» de un bloque (corte 3): el diálogo abre con ese largo agregado. */
  addLengthM?: string | undefined;
  onSaved: (updated: ProductionOrderDto) => void;
}) {
  const fixedLengthMm = order.productUnit === Unit.MTR ? null : order.productLengthMm;
  const exact = planNeedsExactMeters(order);
  const reported = reportedByLength(order);
  const [rows, setRows] = useState<PieceRow[]>([]);
  const [attempted, setAttempted] = useState(false);

  // Cada vez que se abre, parte del plan vigente.
  useEffect(() => {
    if (!open) return;
    const base: PieceRow[] =
      fixedLengthMm !== null
        ? [
            {
              lengthM: mmToMeters(fixedLengthMm),
              qty: String(order.planItems.reduce((acc, p) => acc + p.qty, 0) || ''),
            },
          ]
        : order.planItems.map((p) => ({ lengthM: mmToMeters(p.lengthMm), qty: String(p.qty) }));
    setRows(
      addLengthM === undefined || fixedLengthMm !== null
        ? base
        : [...base, { lengthM: addLengthM, qty: '' }],
    );
    setAttempted(false);
    // Solo al abrir: mientras está abierto, las filas son del usuario.
  }, [open]);

  const parsed = parsePieceRows(rows);
  const check = parsed.ok
    ? checkRoofingPlanAdjustment({
        current: order.planItems,
        next: parsed.pieces,
        reported: [...reported].map(([lengthMm, qty]) => ({ lengthMm, qty })),
        exactMeters: exact,
      })
    : null;
  const planMeters = parsed.ok ? piecesMeters(parsed.pieces) : null;
  const originalMeters = piecesMeters(order.planItems);
  const valid = parsed.ok && check?.ok === true;

  const save = useMutation({
    mutationFn: (pieces: RoofingPieceDto[]) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/plan`, {
        method: 'PUT',
        body: { items: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })) },
      }),
    onSuccess: (updated) => {
      toast.success('Plan de corte actualizado');
      onSaved(updated);
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo guardar el plan')),
  });

  const set = (i: number, patch: Partial<PieceRow>) => {
    setRows((prev) => prev.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  };

  const summary = parsed.ok ? summarize(order.planItems, parsed.pieces) : null;
  const diff = planMeters === null ? null : planMeters.minus(originalMeters);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ajustar el plan de {order.code}</DialogTitle>
          <DialogDescription>
            {fixedLengthMm !== null
              ? `Plancha de catálogo de ${mmToMeters(fixedLengthMm)} m: solo cambia la cantidad. Lo ya reportado no se puede bajar.`
              : 'Cambia largos o planchas de lo que falta cortar. El total tiene que dar los mismos metros del plan original, ni más ni menos. Lo ya reportado no se puede bajar.'}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border">
          <Table aria-label={`Plan de ${order.code}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Largo</TableHead>
                <TableHead>Planchas</TableHead>
                <TableHead className="text-right">Ya reportadas</TableHead>
                <TableHead className="text-right">Metros</TableHead>
                <TableHead className="w-40 text-right">
                  <span className="sr-only">Quitar</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                const key = keyOf(row.lengthM);
                const done = key === null ? 0 : (reported.get(key) ?? 0);
                const qty = /^\d+$/.test(row.qty.trim()) ? Number(row.qty.trim()) : null;
                const below = done > 0 && qty !== null && qty < done;
                const meters =
                  key !== null && qty !== null
                    ? piecesMeters([{ lengthMm: key, qty }]).toFixed(3)
                    : '—';
                return (
                  <TableRow key={i} className="align-top">
                    <TableCell className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          aria-label={`Largo ${String(i + 1)} del plan en metros`}
                          inputMode="decimal"
                          className="h-8 w-28 text-right tabular-nums"
                          value={row.lengthM}
                          disabled={fixedLengthMm !== null || done > 0}
                          onChange={(e) => {
                            set(i, { lengthM: e.target.value });
                          }}
                        />
                        <span className="text-xs text-muted-foreground">m</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          aria-label={`Planchas del largo ${String(i + 1)} del plan`}
                          aria-invalid={below || undefined}
                          inputMode="numeric"
                          className="h-8 w-24 text-right tabular-nums"
                          value={row.qty}
                          onChange={(e) => {
                            set(i, { qty: e.target.value });
                          }}
                        />
                        <span className="text-xs text-muted-foreground">pl</span>
                      </div>
                      {done > 0 && (
                        <p
                          className={cn(
                            'mt-0.5 text-xs',
                            below ? 'text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          no menos de {done}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{done}</TableCell>
                    <TableCell className="text-right tabular-nums">{meters} m</TableCell>
                    <TableCell className="text-right">
                      {done > 0 ? (
                        <span className="text-xs text-muted-foreground">no se puede quitar</span>
                      ) : rows.length > 1 && fixedLengthMm === null ? (
                        <Button
                          variant="link"
                          size="sm"
                          aria-label={`Quitar el largo ${String(i + 1)} del plan`}
                          onClick={() => {
                            setRows((prev) => prev.filter((_, j) => j !== i));
                          }}
                        >
                          Quitar
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {fixedLengthMm === null && (
            <div className="border-t px-3 py-2">
              <Button
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => {
                  setRows((prev) => [...prev, { lengthM: '', qty: '' }]);
                }}
              >
                + Agregar largo
              </Button>
            </div>
          )}
        </div>

        {!parsed.ok ? (
          attempted && (
            <p role="alert" className="text-sm text-destructive">
              {parsed.reason}
            </p>
          )
        ) : (
          <div
            role="status"
            data-testid="plan-cuadre"
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm',
              valid
                ? 'border-tone-done-foreground/30 bg-tone-done text-tone-done-foreground'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
          >
            <span>
              Metros del plan{' '}
              <span className="font-semibold tabular-nums">
                {planMeters?.toFixed(3)}
                {exact && ` de ${originalMeters.toFixed(3)} m`}
              </span>{' '}
              {exact ? 'del original' : `m (antes ${originalMeters.toFixed(3)} m)`}
            </span>
            <span className="font-semibold">
              {valid
                ? exact
                  ? 'Cuadra ✓'
                  : 'Se puede guardar'
                : check?.ok === false && check.kind === 'meters' && diff !== null
                  ? `${diff.gt(0) ? 'Sobran' : 'Faltan'} ${diff.abs().toFixed(3)} m: no se guarda`
                  : 'No se guarda'}
            </span>
          </div>
        )}
        {attempted && check?.ok === false && (
          <p role="alert" className="text-sm text-destructive">
            {check.message}
          </p>
        )}

        {summary !== null && (
          <div className="grid gap-1 rounded-lg bg-muted px-3 py-2">
            <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
            {summary.lines.length === 0 ? (
              <p className="text-sm">El plan queda igual.</p>
            ) : (
              summary.lines.map((line) => (
                <p key={line} className="text-sm">
                  {line}
                </p>
              ))
            )}
          </div>
        )}

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
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              setAttempted(true);
              if (save.isPending || !parsed.ok || !valid) return;
              save.mutate(parsed.pieces);
            }}
          >
            Guardar el plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
