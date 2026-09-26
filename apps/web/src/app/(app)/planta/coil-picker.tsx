'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MAX_ORDER_STRIPS,
  ROOFING_THICKNESS_TOLERANCE_MM,
  type RoofingCoilOptionDto,
} from '@ayr/shared';
import { formatQty } from '@/lib/format';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { FilmOpenNotice } from '@/components/film-open-notice';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Elegir las bobinas a montar (D-159, ampliado por D-192).
 *
 * Una tabla y no una lista de tarjetas: lo que decide cuál montar son cifras —espesor, color,
 * **peso inicial** y kilos disponibles— que hay que comparar entre filas. D-192 agrega dos
 * cosas que planta pidió: el peso con el que entró el rollo (para reconocerlo en el almacén:
 * el disponible teórico no se ve en la bobina, el peso de la etiqueta sí) y **montar varias a la
 * vez** — un pedido largo se rola de más de un rollo y montarlas de a una era abrir el modal N
 * veces. Cada fila conserva su botón «Montar» para el caso normal de una sola.
 *
 * No filtra nada por su cuenta: las bobinas que llegan ya vienen filtradas por el API
 * (`GET /production/roofing/coils`, D-086) y una que no aparezca acá tampoco se puede montar.
 * Tampoco ordena: el API ya pone primero las del acabado exacto del producto (D-271).
 */
export function CoilPicker({
  orderCode,
  productSku,
  options,
  mountedCount,
  loading,
  failed,
  pending,
  disabled = false,
  onMount,
}: {
  orderCode: string;
  productSku: string;
  options: readonly RoofingCoilOptionDto[];
  /** Bobinas ya montadas en la orden: el tope de `MAX_ORDER_STRIPS` cuenta las dos. */
  mountedCount: number;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  disabled?: boolean | undefined;
  /** D-193: `reopen` viaja solo cuando planta confirmó reabrir una bobina cerrada. */
  onMount: (coilIds: string[], reopen?: { coilIds: string[]; reason: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** D-193: la cerrada que se está por reabrir (paso de confirmación), y su motivo. */
  const [reopening, setReopening] = useState<RoofingCoilOptionDto | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  /** D-328: el paso de confirmación de abrir el film de las bobinas selladas que se van a montar. */
  const [filmStep, setFilmStep] = useState<{
    coilIds: string[];
    sealed: RoofingCoilOptionDto[];
  } | null>(null);

  // El filtro y la selección no sobreviven al cierre: reabrir con una selección vieja montaría
  // rollos que ya nadie está mirando.
  useEffect(() => {
    if (open) {
      setFilter('');
      setSelected(new Set());
      setFilmStep(null);
      setReopening(null);
      setReopenReason('');
      setShowClosed(false);
    }
  }, [open]);

  const openOptions = useMemo(() => options.filter((c) => c.status === 'OPEN'), [options]);
  const closedOptions = useMemo(() => options.filter((c) => c.status === 'CLOSED'), [options]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return openOptions;
    return openOptions.filter((c) =>
      `${c.code} ${c.colorName ?? ''} ${c.finishName} ${c.ral ?? ''} ${c.thicknessMm} ${c.widthMm} ${c.weightKg} ${c.availableKg}`
        .toLowerCase()
        .includes(needle),
    );
  }, [openOptions, filter]);

  const room = Math.max(MAX_ORDER_STRIPS - mountedCount, 0);
  /** Solo lo elegido que el filtro deja a la vista: no se monta un rollo que nadie está mirando. */
  const visibleSelected = matches.filter((c) => selected.has(c.coilId)).map((c) => c.coilId);
  const overLimit = visibleSelected.length > room;

  if (loading) return <Skeleton className="h-12 w-full" />;
  if (failed) {
    return (
      <p className="text-sm text-destructive">No se pudieron cargar las bobinas disponibles.</p>
    );
  }
  if (openOptions.length === 0 && closedOptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay bobinas libres del color comercial y el espesor de {productSku} (±
        {ROOFING_THICKNESS_TOLERANCE_MM} mm). Una bobina en corte tercerizado, montada en otra orden
        o prometida a otro pedido tampoco aparece acá.
      </p>
    );
  }

  // D-328: montar una bobina sellada la abre. Antes de montar se pide la confirmación explícita
  // —un paso aparte, como el de reabrir una terminada—; si ninguna está sellada, se monta directo.
  const mount = (ids: string[]) => {
    const sealed = openOptions.filter((c) => ids.includes(c.coilId) && c.film === 'SEALED');
    if (sealed.length > 0) {
      setFilmStep({ coilIds: ids, sealed });
      return;
    }
    onMount(ids);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        className="justify-self-start"
        aria-label={`Buscar una bobina para ${orderCode}`}
        disabled={disabled || pending}
        onClick={() => {
          setOpen(true);
        }}
      >
        Buscar y montar bobinas ({openOptions.length})
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Bobinas para {orderCode}</DialogTitle>
            <DialogDescription>
              {openOptions.length} bobinas libres del espesor y el color comercial de {productSku}.{' '}
              {openOptions.some((c) => c.exactFinish)
                ? 'Arriba van las del mismo acabado (RAL) que el producto; las demás también se pueden montar. '
                : 'Ninguna es del mismo acabado (RAL) que el producto; todas se pueden montar. '}
              Monta una con su botón, o elige varias y móntalas juntas.
            </DialogDescription>
          </DialogHeader>
          {filmStep !== null ? (
            <div className="grid gap-3" data-testid="film-open-step">
              <FilmOpenNotice
                coils={filmStep.sealed.map((c) => ({
                  code: c.code,
                  status: 'OPEN' as const,
                  film: c.film,
                }))}
              />
              <p className="text-sm text-muted-foreground">
                Abrir el film no mueve el kardex. Si después bajas la bobina de la orden sin haber
                reportado planchas, vuelve a quedar sellada.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setFilmStep(null);
                  }}
                >
                  Volver
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => {
                    onMount(filmStep.coilIds);
                    setOpen(false);
                  }}
                >
                  {filmStep.coilIds.length === 1
                    ? 'Abrir y montar'
                    : `Abrir y montar ${String(filmStep.coilIds.length)}`}
                </Button>
              </DialogFooter>
            </div>
          ) : reopening !== null ? (
            <ReopenStep
              coil={reopening}
              reason={reopenReason}
              pending={pending}
              onReason={setReopenReason}
              onBack={() => {
                setReopening(null);
                setReopenReason('');
              }}
              onConfirm={() => {
                onMount([reopening.coilId], {
                  coilIds: [reopening.coilId],
                  reason: reopenReason.trim(),
                });
                setOpen(false);
              }}
            />
          ) : (
            <div className="grid gap-3">
              <Input
                autoFocus
                aria-label="Filtrar opciones"
                placeholder="Filtra por código, color, RAL o kilos…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {matches.length} de {openOptions.length} bobinas
                {selected.size > 0 && <> · {selected.size} elegidas</>}
              </p>
              <div className="max-h-96 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <TableHead className="w-10">
                        <span className="sr-only">Elegir</span>
                      </TableHead>
                      <TableHead>Bobina</TableHead>
                      <TableHead>Espesor</TableHead>
                      <TableHead>Color</TableHead>
                      <TableHead>Acabado (RAL)</TableHead>
                      <TableHead className="text-right">Peso inicial</TableHead>
                      <TableHead className="text-right">kg disponibles</TableHead>
                      <TableHead className="w-28 text-right">Montar</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matches.map((c) => (
                      <TableRow
                        key={c.coilId}
                        data-state={selected.has(c.coilId) ? 'selected' : undefined}
                      >
                        <TableCell>
                          <Checkbox
                            aria-label={`Elegir ${c.code}`}
                            checked={selected.has(c.coilId)}
                            onCheckedChange={(checked) => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (checked === true) next.add(c.coilId);
                                else next.delete(c.coilId);
                                return next;
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-mono font-medium">
                            {c.code}{' '}
                            <Badge variant={c.film === 'SEALED' ? 'outline' : 'progress'}>
                              {c.film === 'SEALED' ? 'Sellada' : 'Abierta'}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            alcanza para {c.estimatedMeters} m
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{c.thicknessMm} mm</TableCell>
                        <TableCell>
                          <ColorSwatch
                            color={
                              c.colorName && c.colorHex
                                ? { name: c.colorName, hexColor: c.colorHex }
                                : null
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <FinishCell coil={c} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(c.weightKg, 'kg')}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(c.availableKg, 'kg')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Montar ${c.code}`}
                            disabled={pending || room === 0}
                            onClick={() => {
                              mount([c.coilId]);
                            }}
                          >
                            Montar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {matches.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground">
                          {openOptions.length === 0
                            ? 'No hay bobinas libres de esta spec: mira las terminadas.'
                            : 'Ninguna bobina coincide con ese texto.'}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {/*
              D-193: las terminadas (antes «cerradas», D-328) del mismo espesor y color. Se ven a
              pedido, separadas de las libres, y su botón no monta: abre el paso que dice qué
              ajuste se va a revertir.
            */}
              {closedOptions.length > 0 && (
                <div className="grid gap-2">
                  <Button
                    variant="ghost"
                    className="justify-self-start"
                    aria-expanded={showClosed}
                    onClick={() => {
                      setShowClosed((v) => !v);
                    }}
                  >
                    {showClosed ? 'Ocultar' : 'Ver'} bobinas terminadas ({closedOptions.length})
                  </Button>
                  {showClosed && (
                    <div className="max-h-60 overflow-auto rounded-lg border">
                      <Table aria-label="Bobinas terminadas">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Bobina terminada</TableHead>
                            <TableHead>Acabado (RAL)</TableHead>
                            <TableHead className="text-right">Peso inicial</TableHead>
                            <TableHead className="text-right">Ajuste del cierre</TableHead>
                            <TableHead className="text-right">kg al reabrir</TableHead>
                            <TableHead className="w-40 text-right">Reabrir</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {closedOptions.map((c) => (
                            <TableRow key={c.coilId}>
                              <TableCell className="font-mono font-medium">{c.code}</TableCell>
                              <TableCell>
                                <FinishCell coil={c} />
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatQty(c.weightKg, 'kg')}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {c.closeAdjustment === null
                                  ? '—'
                                  : `${c.closeAdjustment.kind === 'SHORTAGE' ? '−' : '+'}${formatQty(c.closeAdjustment.qtyKg, 'kg')}`}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatQty(c.availableKg, 'kg')}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label={`Reabrir y montar ${c.code}`}
                                  disabled={pending || room === 0}
                                  onClick={() => {
                                    setReopening(c);
                                  }}
                                >
                                  Reabrir y montar
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
              {overLimit && (
                <p className="text-sm text-destructive">
                  La orden admite {MAX_ORDER_STRIPS} bobinas a la vez y ya tiene {mountedCount}:
                  elige como máximo {room}.
                </p>
              )}
            </div>
          )}
          {reopening === null && filmStep === null && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                aria-label={
                  visibleSelected.length === 1
                    ? `Montar la bobina elegida en ${orderCode}`
                    : `Montar las ${String(visibleSelected.length)} bobinas elegidas en ${orderCode}`
                }
                disabled={visibleSelected.length === 0 || overLimit || pending}
                onClick={() => {
                  mount(visibleSelected);
                }}
              >
                {visibleSelected.length === 1
                  ? 'Montar la elegida'
                  : `Montar las ${String(visibleSelected.length)} elegidas`}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * D-271: el acabado de la bobina con su RAL, y si es el mismo acabado que el producto. El
 * color comercial ya está en su columna; lo que distingue a dos bobinas ROJO es esto.
 */
function FinishCell({ coil }: { coil: RoofingCoilOptionDto }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="font-medium tabular-nums">
        {coil.ral === null ? 'Sin RAL' : `RAL ${coil.ral}`}
      </span>
      {coil.exactFinish && <Badge variant="secondary">Mismo acabado</Badge>}
      <span className="w-full text-xs text-muted-foreground">{coil.finishName}</span>
    </div>
  );
}

/**
 * D-193: el paso explícito antes de reabrir una bobina terminada. Dice **qué** va a pasar en el
 * kardex —el ajuste del cierre se revierte con un asiento compensatorio, el original no se toca—
 * y pide el motivo que la reversa exige. Sin este clic nada se mueve.
 */
function ReopenStep({
  coil,
  reason,
  pending,
  onReason,
  onBack,
  onConfirm,
}: {
  coil: RoofingCoilOptionDto;
  reason: string;
  pending: boolean;
  onReason: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const adjustment = coil.closeAdjustment;
  return (
    <div className="grid gap-3">
      <div
        role="alert"
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      >
        {adjustment === null ? (
          <>
            <span className="font-mono font-medium">{coil.code}</span> está terminada sin un ajuste
            de cierre pendiente: reabrirla no mueve el kardex.
          </>
        ) : (
          <>
            <span className="font-mono font-medium">{coil.code}</span> terminada con ajuste de{' '}
            {formatQty(adjustment.qtyKg, 'kg')} (
            {adjustment.kind === 'SHORTAGE' ? 'faltante' : 'sobrante'}) — reabrirla revierte el
            ajuste: {adjustment.kind === 'SHORTAGE' ? 'vuelven al kardex' : 'salen del kardex'}{' '}
            {formatQty(adjustment.qtyKg, 'kg')} con un asiento compensatorio. Al terminarla de nuevo
            se calcula un ajuste nuevo con el saldo real.
          </>
        )}{' '}
        Queda montada en esta orden con {formatQty(coil.availableKg, 'kg')}.
      </div>
      <FilmOpenNotice
        coils={[{ code: coil.code, status: 'OPEN', film: coil.film }]}
        className="rounded-lg bg-tone-warning p-3 text-sm text-tone-warning-foreground"
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`reabrir-${coil.coilId}`}>Motivo de la reapertura</Label>
        <Input
          id={`reabrir-${coil.coilId}`}
          aria-label={`Motivo para reabrir ${coil.code}`}
          value={reason}
          onChange={(e) => {
            onReason(e.target.value);
          }}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Volver
        </Button>
        <Button
          aria-label={`Confirmar: reabrir y montar ${coil.code}`}
          disabled={reason.trim().length < 3 || pending}
          onClick={onConfirm}
        >
          Reabrir y montar
        </Button>
      </DialogFooter>
    </div>
  );
}
