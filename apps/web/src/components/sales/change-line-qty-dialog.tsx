'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QTY_CHANGE_REASONS,
  type SalesItemDto,
  type SalesOrderDto,
  type SalesOrderItemQtyPreviewDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatMoney, formatQty, formatUnits, unitSymbol } from '@/lib/format';
import { errorMessage, toast } from '@/lib/notify';
import { mmToMetersShort } from '@/lib/pieces';
import { invalidateProduction } from '@/lib/production-queries';
import {
  addedRow,
  draftFromRows,
  draftFromSingle,
  initialRows,
  lowerRowsToRegistered,
  rowMeters,
  sameAsCurrent,
  totalDifference,
  type QtyDraft,
  type QtyLengthRow,
} from '@/lib/qty-change';
import { invalidateSales } from '@/lib/sales-queries';
import { useDebounced } from '@/lib/use-debounced';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const OTHER = 'Otro';

const KIND_LABEL: Record<SalesOrderItemQtyPreviewDto['kind'], string> = {
  PIECES: 'a medida',
  UNITS: 'plancha de catálogo',
  METERS: 'accesorio',
  QTY: '',
};

function previewUrl(orderId: string, itemId: string): string {
  return `/sales/orders/${orderId}/items/${itemId}/qty-preview`;
}

/** «258.800 m · S/ 4,787.80», la franja Antes / Después. */
function amountLine(
  kind: SalesOrderItemQtyPreviewDto['kind'],
  unit: string,
  qty: string,
  totalPen: string,
): string {
  const measure =
    kind === 'PIECES' || kind === 'METERS'
      ? formatQty(qty, 'm')
      : kind === 'UNITS'
        ? `${formatUnits(qty, null)} planchas`
        : formatQty(qty, unitSymbol(unit));
  return `${measure} · ${formatMoney(totalPen)}`;
}

/**
 * cc45 (D-603, D-604): «Cambiar cantidad» de una línea del pedido, también con producción en
 * curso. La tabla por largo (a medida) o la fila única (plancha de catálogo, accesorio, stock)
 * muestra lo pedido y lo registrado, y el piso se ve antes de guardar. «Qué va a pasar» es la
 * vista previa del API, que corre la misma acción y la deshace: la pantalla no promete algo que el
 * guardado no hace. El motivo es obligatorio.
 */
export function ChangeLineQtyDialog({
  order,
  item,
  onOpenChange,
}: {
  order: SalesOrderDto;
  item: SalesItemDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // Lo que se muestra sale de esto y no de `item`: al cerrar, `item` pasa a null en plena
  // animación de salida (ver `EditLinePriceDialog`).
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);
  const [rows, setRows] = useState<QtyLengthRow[]>([]);
  const [single, setSingle] = useState('');
  const [reason, setReason] = useState('');
  const [otherReason, setOtherReason] = useState('');
  const [confirmShortfall, setConfirmShortfall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // La línea para la que ya se cargó la tabla: una vista previa que se vuelve a pedir no pisa lo
  // que se está escribiendo.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const itemId = lastItem?.id ?? '';

  useEffect(() => {
    if (item) {
      setLastItem(item);
      setReason('');
      setOtherReason('');
      setConfirmShortfall(false);
      setError(null);
      setLoadedFor(null);
    }
  }, [item]);

  const context = useQuery({
    queryKey: ['sales-order-qty-preview', order.id, itemId, 'context'],
    queryFn: () =>
      api<SalesOrderItemQtyPreviewDto>(previewUrl(order.id, itemId), { method: 'POST', body: {} }),
    enabled: item !== null,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const ctx = context.data?.itemId === itemId ? context.data : undefined;
  if (ctx && item !== null && loadedFor !== ctx.itemId) {
    setLoadedFor(ctx.itemId);
    setRows(initialRows(ctx));
    setSingle(ctx.kind === 'UNITS' ? String(Number(ctx.qty)) : ctx.qty);
  }

  const draft: QtyDraft | null = useMemo(() => {
    if (!ctx) return null;
    return ctx.kind === 'PIECES' ? draftFromRows(rows) : draftFromSingle(single, ctx);
  }, [ctx, rows, single]);
  const same = ctx !== undefined && draft !== null && sameAsCurrent(draft, ctx);
  const payload =
    draft?.ok === true && !same
      ? JSON.stringify({
          qty: draft.qty,
          ...(draft.pieces ? { pieces: draft.pieces } : {}),
        })
      : null;
  // Cada vista previa bloquea las filas de la acción: medio segundo entre teclas.
  const debounced = useDebounced(payload, 500);

  const preview = useQuery({
    queryKey: ['sales-order-qty-preview', order.id, itemId, debounced],
    queryFn: () =>
      api<SalesOrderItemQtyPreviewDto>(previewUrl(order.id, itemId), {
        method: 'POST',
        body: JSON.parse(debounced ?? '{}') as unknown,
      }),
    enabled: item !== null && debounced !== null && debounced === payload,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const outcome =
    payload !== null && debounced === payload ? (preview.data?.outcome ?? undefined) : undefined;
  const shortfall = outcome?.ok === true ? outcome.shortfallQty : null;

  const reasonText = reason === OTHER ? otherReason.trim() : reason;
  const reasonOk = reasonText.length >= 5;

  const save = useMutation({
    mutationFn: () => {
      if (draft?.ok !== true) throw new Error('Cantidad inválida');
      return api<SalesOrderDto>(`/sales/orders/${order.id}/items/${itemId}/qty`, {
        method: 'PATCH',
        body: {
          qty: draft.qty,
          ...(draft.pieces ? { pieces: draft.pieces } : {}),
          reason: reasonText,
          ...(shortfall !== null ? { confirmShortfall } : {}),
        },
      });
    },
    onSuccess: () => {
      toast.success('Cantidad actualizada');
      invalidateSales(queryClient, { orderId: order.id });
      // El plan de la OP, la reserva y quizá una OP nueva cambiaron con la cantidad.
      invalidateProduction(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['sales-order-qty-preview', order.id] });
      void queryClient.invalidateQueries({
        queryKey: ['production-orders', 'sales-order', order.id],
      });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorMessage(err, 'No se pudo cambiar la cantidad'));
    },
  });

  const canSave =
    ctx?.blocked === null &&
    draft?.ok === true &&
    !same &&
    outcome?.ok === true &&
    reasonOk &&
    (shortfall === null || confirmShortfall) &&
    !save.isPending;

  const kindLabel = ctx ? KIND_LABEL[ctx.kind] : '';
  const unit = ctx ? unitSymbol(ctx.unit) : '';

  function patchRow(key: string, patch: Partial<QtyLengthRow>): void {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setError(null);
  }

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Cambiar la cantidad · línea {lastItem?.lineNumber} de {order.code}
          </DialogTitle>
          <DialogDescription>
            {lastItem?.productSku}
            {kindLabel ? ` ${kindLabel}` : ''}
            {ctx?.adminOnly ? ' · solo administrador' : ''} · antes del comprobante
          </DialogDescription>
        </DialogHeader>

        {!ctx ? (
          context.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {errorMessage(context.error, 'No se pudo leer la línea')}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )
        ) : ctx.blocked !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{ctx.blocked}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <div className="flex gap-2">
              {ctx.hasProduction && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (ctx.kind === 'PIECES') setRows((r) => lowerRowsToRegistered(r));
                    else
                      setSingle(
                        ctx.kind === 'UNITS'
                          ? String(Number(ctx.registeredQty))
                          : ctx.registeredQty,
                      );
                    setError(null);
                  }}
                >
                  Bajar a lo registrado
                </Button>
              )}
              {ctx.kind === 'PIECES' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRows((r) => [...r, addedRow()]);
                  }}
                >
                  + Otro largo
                </Button>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>{ctx.kind === 'PIECES' ? 'Largo' : 'Cantidad'}</TableHead>
                    <TableHead className="text-right">Pedido</TableHead>
                    <TableHead className="text-right">Registrado</TableHead>
                    {ctx.hasDispatches && <TableHead className="text-right">Despachado</TableHead>}
                    <TableHead className="text-right">Nuevo</TableHead>
                    {ctx.kind === 'PIECES' && <TableHead className="text-right">Metros</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody className="tabular-nums">
                  {ctx.kind === 'PIECES' ? (
                    rows.map((r) => {
                      // Las filas nuevas se cuentan entre ellas: «largo nuevo 1», «largo nuevo 2».
                      const added = rows.filter((x) => x.lengthMm === null);
                      const label =
                        r.lengthMm !== null
                          ? `${mmToMetersShort(r.lengthMm)} m`
                          : `largo nuevo ${String(added.indexOf(r) + 1)}`;
                      const meters = rowMeters(r);
                      const below = /^\d+$/.test(r.next.trim()) && Number(r.next) < r.registered;
                      return (
                        <TableRow
                          key={r.key}
                          className={r.lengthMm === null ? 'bg-primary/5' : undefined}
                        >
                          <TableCell className="font-semibold">
                            {r.lengthMm !== null ? (
                              label
                            ) : (
                              <div className="flex items-center gap-1">
                                <Input
                                  className="h-8 w-24 text-right"
                                  inputMode="decimal"
                                  aria-label={`Metros del ${label}`}
                                  placeholder="m"
                                  value={r.lengthM}
                                  onChange={(e) => {
                                    patchRow(r.key, { lengthM: e.target.value });
                                  }}
                                />
                                <span className="text-muted-foreground">m</span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Quitar el ${label}`}
                                  onClick={() => {
                                    setRows((current) => current.filter((x) => x.key !== r.key));
                                  }}
                                >
                                  ✕
                                </Button>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{r.ordered}</TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {r.registered}
                          </TableCell>
                          {ctx.hasDispatches && <TableCell className="text-right">—</TableCell>}
                          <TableCell className="text-right">
                            <Input
                              className="ml-auto h-8 w-20 text-right"
                              inputMode="numeric"
                              aria-label={`Nuevo · ${label}`}
                              aria-invalid={below}
                              value={r.next}
                              onChange={(e) => {
                                patchRow(r.key, { next: e.target.value });
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {meters === null ? '—' : formatQty(meters, 'm')}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell className="font-semibold">
                        {ctx.kind === 'UNITS'
                          ? 'Planchas'
                          : ctx.kind === 'METERS'
                            ? 'Metros de bobina'
                            : unit}
                      </TableCell>
                      <TableCell className="text-right">{formatQty(ctx.qty, unit)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatQty(ctx.registeredQty, unit)}
                      </TableCell>
                      {ctx.hasDispatches && (
                        <TableCell className="text-right">
                          {formatQty(ctx.dispatchedQty, unit)}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        <Input
                          className="ml-auto h-8 w-28 text-right"
                          inputMode="decimal"
                          aria-label={`Nuevo (${unit})`}
                          value={single}
                          onChange={(e) => {
                            setSingle(e.target.value);
                            setError(null);
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {ctx.hasProduction || ctx.hasDispatches ? (
              <p className="text-xs text-muted-foreground">
                {ctx.kind === 'PIECES'
                  ? 'No se puede bajar un largo por debajo de lo ya registrado'
                  : `No se puede bajar de ${formatQty(ctx.minQty, unit)}, lo ya ${ctx.hasProduction ? 'registrado' : 'despachado'}`}
                {ctx.hasDispatches && ctx.kind === 'PIECES'
                  ? `, ni la línea por debajo de lo despachado (${formatQty(ctx.dispatchedQty, unit)})`
                  : ''}
                .
              </p>
            ) : null}

            <div className="flex flex-wrap gap-6 rounded-lg bg-muted/50 px-3 py-2">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Antes</span>
                <span className="font-semibold tabular-nums">
                  {amountLine(ctx.kind, ctx.unit, ctx.qty, ctx.totalPen)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Después</span>
                <span className="font-semibold tabular-nums" data-testid="qty-after">
                  {outcome?.ok === true && outcome.qty && outcome.totalPen
                    ? amountLine(ctx.kind, ctx.unit, outcome.qty, outcome.totalPen)
                    : '—'}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Diferencia</span>
                <span className="font-semibold tabular-nums">
                  {outcome?.ok === true && outcome.totalPen
                    ? (() => {
                        const d = totalDifference(ctx.totalPen, outcome.totalPen);
                        return `${d.sign} ${formatMoney(d.abs)}`;
                      })()
                    : '—'}
                </span>
              </div>
            </div>

            <div className="grid gap-1">
              <Label htmlFor="qty-reason">Motivo</Label>
              <Select
                value={reason}
                onValueChange={(v) => {
                  setReason(v);
                  setError(null);
                }}
              >
                <SelectTrigger id="qty-reason" className="w-full" aria-label="Motivo del cambio">
                  <SelectValue placeholder="Elige el motivo" />
                </SelectTrigger>
                <SelectContent>
                  {QTY_CHANGE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER}>Otro</SelectItem>
                </SelectContent>
              </Select>
              {reason === OTHER && (
                <Input
                  aria-label="Motivo (otro)"
                  placeholder="Explica el motivo (mínimo 5 caracteres)"
                  value={otherReason}
                  onChange={(e) => {
                    setOtherReason(e.target.value);
                  }}
                />
              )}
            </div>

            <div
              className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm"
              aria-live="polite"
              data-testid="qty-effects"
            >
              <span className="text-xs font-semibold">Qué va a pasar</span>
              {draft?.ok === false ? (
                <span className="text-destructive">{draft.reason}</span>
              ) : same ? (
                <span className="text-muted-foreground">
                  Cambia algún valor para ver qué pasaría.
                </span>
              ) : preview.isError && debounced === payload ? (
                <span className="text-destructive">
                  {errorMessage(preview.error, 'No se pudo calcular qué va a pasar')}
                </span>
              ) : outcome === undefined ? (
                <span className="text-muted-foreground">Calculando…</span>
              ) : outcome.ok ? (
                outcome.effects.map((e) => <span key={e}>{e}</span>)
              ) : (
                <span className="text-destructive">{outcome.message}</span>
              )}
            </div>

            {shortfall !== null && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="qty-shortfall"
                  checked={confirmShortfall}
                  onCheckedChange={(v) => {
                    setConfirmShortfall(v === true);
                  }}
                />
                <Label htmlFor="qty-shortfall" className="font-normal">
                  Confirmar con faltante: faltan {formatQty(shortfall, 'kg')} de material (D-341).
                </Label>
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
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
            disabled={!canSave}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              if (canSave) save.mutate();
            }}
          >
            Guardar el cambio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
