'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Decimal,
  MAX_ORDER_STRIPS,
  ROOFING_THICKNESS_TOLERANCE_MM,
  type RoofingCoilOptionDto,
} from '@ayr/shared';
import { formatQtyAsIs } from '@/lib/format';
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
  remainingMeters,
  productName,
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
  /** cc35: lo que falta cortar de la orden, para el encabezado del modal. */
  remainingMeters?: string | undefined;
  /** cc35: el nombre del producto («Cobertura TR4 Aluzinc 0.30 mm Rojo») para el encabezado. */
  productName?: string | undefined;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  disabled?: boolean | undefined;
  /** D-193: `reopen` viaja solo cuando planta confirmó reabrir una bobina cerrada. */
  onMount: (
    coilIds: string[],
    reopen?: { coilIds: string[]; reason: string; physicalKg?: string },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** D-193: la cerrada que se está por reabrir (paso de confirmación), y su motivo. */
  const [reopening, setReopening] = useState<RoofingCoilOptionDto | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  /** cc29 (D-466): el peso físico de una terminada con el kardex en 0. */
  const [physicalKg, setPhysicalKg] = useState('');
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
      setPhysicalKg('');
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
        o prometida a otro pedido tampoco aparece aquí.
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

  const chosen = openOptions.filter((c) => visibleSelected.includes(c.coilId));
  const chosenKg = chosen.reduce((acc, c) => acc.plus(c.availableKg), new Decimal(0));
  const chosenMeters = chosen.reduce((acc, c) => acc.plus(c.estimatedMeters), new Decimal(0));
  const chosenSealed = chosen.filter((c) => c.film === 'SEALED');
  /** Marcadas que la búsqueda deja fuera: no se montan (no se monta lo que nadie está mirando). */
  const hiddenSelected = openOptions.filter(
    (c) => selected.has(c.coilId) && !visibleSelected.includes(c.coilId),
  ).length;
  // Kilos por metro de la spec, de la primera bobina con rinde: solo para decir cuánto falta.
  const sample = openOptions.find((c) => new Decimal(c.estimatedMeters).gt(0));
  const remainingKg =
    remainingMeters === undefined || sample === undefined
      ? null
      : new Decimal(remainingMeters).times(sample.availableKg).div(sample.estimatedMeters);
  const exact = matches.filter((c) => c.exactFinish);
  const others = matches.filter((c) => !c.exactFinish);
  const toggle = (coilId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(coilId);
      else next.delete(coilId);
      return next;
    });
  };
  const groupRow = (label: string) => (
    <TableRow className="bg-muted/50 hover:bg-muted/50">
      <TableCell colSpan={7} className="text-xs font-medium text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  );
  const coilRow = (c: RoofingCoilOptionDto) => {
    const checked = selected.has(c.coilId);
    const used = Decimal.max(new Decimal(c.weightKg).minus(c.availableKg), new Decimal(0));
    return (
      <TableRow
        key={c.coilId}
        data-state={checked ? 'selected' : undefined}
        className="cursor-pointer"
        onClick={() => {
          toggle(c.coilId, !checked);
        }}
      >
        <TableCell
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Checkbox
            aria-label={`Elegir ${c.code}`}
            checked={checked}
            onCheckedChange={(value) => {
              toggle(c.coilId, value === true);
            }}
          />
        </TableCell>
        <TableCell>
          <div className="font-mono font-medium">{c.code}</div>
          <div className="whitespace-nowrap text-xs text-muted-foreground">
            {new Decimal(c.thicknessMm).toString()} mm · {c.colorName ?? 'Sin color'} ·{' '}
            {c.ral === null ? 'Sin RAL' : `RAL ${c.ral}`} · {new Decimal(c.widthMm).toString()} mm
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={c.film === 'SEALED' ? 'outline' : 'progress'}>
            {c.film === 'SEALED' ? 'Sellada' : 'Abierta'}
          </Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatQtyAsIs(c.weightKg, 'kg')}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {formatQtyAsIs(used.toFixed(3), 'kg')}
        </TableCell>
        <TableCell className="text-right font-semibold tabular-nums">
          {formatQtyAsIs(c.availableKg, 'kg')}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          ≈ {formatQtyAsIs(c.estimatedMeters, 'm')}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        aria-label={`Montar bobinas en ${orderCode}`}
        disabled={disabled || pending}
        onClick={() => {
          setOpen(true);
        }}
      >
        Montar bobinas
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Montar bobinas en {orderCode}</DialogTitle>
            <DialogDescription>
              {remainingMeters !== undefined && (
                <>
                  Falta cortar {formatQtyAsIs(remainingMeters, 'm')}
                  {remainingKg !== null && (
                    <> · ≈ {formatQtyAsIs(remainingKg.toFixed(3), 'kg')}</>
                  )}{' '}
                  de {productName ?? productSku}.{' '}
                </>
              )}
              Marca una o más.
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
              physicalKg={physicalKg}
              pending={pending}
              onReason={setReopenReason}
              onPhysicalKg={setPhysicalKg}
              onBack={() => {
                setReopening(null);
                setReopenReason('');
                setPhysicalKg('');
              }}
              onConfirm={() => {
                onMount([reopening.coilId], {
                  coilIds: [reopening.coilId],
                  reason: reopenReason.trim(),
                  ...(reopening.needsPhysicalKg ? { physicalKg: physicalKg.trim() } : {}),
                });
                setOpen(false);
              }}
            />
          ) : (
            <div className="grid gap-3">
              <Input
                autoFocus
                aria-label="Filtrar opciones"
                placeholder="Buscar por código, color o espesor"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                }}
              />
              <div className="max-h-96 overflow-auto rounded-lg border">
                <Table aria-label={`Bobinas para ${orderCode}`}>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <TableHead className="w-10">
                        <span className="sr-only">Elegir</span>
                      </TableHead>
                      <TableHead>Bobina</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">kg inicial</TableHead>
                      <TableHead className="text-right">kg consumido</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                      <TableHead className="text-right">Rinde (m)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exact.length > 0 && groupRow('Del mismo acabado que el producto')}
                    {exact.map(coilRow)}
                    {others.length > 0 &&
                      groupRow(
                        exact.length > 0
                          ? 'Otro acabado del mismo color · también se puede montar'
                          : 'Del mismo color, otro acabado · se puede montar',
                      )}
                    {others.map(coilRow)}
                    {matches.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground">
                          {openOptions.length === 0
                            ? 'No hay bobinas libres de esta spec: mira las terminadas.'
                            : 'Ninguna bobina coincide con esa búsqueda.'}
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
                    variant="link"
                    className="justify-self-start px-0"
                    aria-expanded={showClosed}
                    onClick={() => {
                      setShowClosed((v) => !v);
                    }}
                  >
                    {showClosed
                      ? 'Ocultar las bobinas terminadas'
                      : `Ver las ${String(closedOptions.length)} bobinas terminadas, para reabrir`}
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
                                {formatQtyAsIs(c.weightKg, 'kg')}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {c.closeAdjustment === null
                                  ? '—'
                                  : `${c.closeAdjustment.kind === 'SHORTAGE' ? '−' : '+'}${formatQtyAsIs(c.closeAdjustment.qtyKg, 'kg')}`}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {c.needsPhysicalKg
                                  ? 'Pide el peso físico'
                                  : formatQtyAsIs(c.availableKg, 'kg')}
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
            <DialogFooter className="items-center sm:justify-between">
              <p className="text-sm text-muted-foreground" data-testid="montar-resumen">
                {visibleSelected.length === 0 ? (
                  'Ninguna elegida'
                ) : (
                  <>
                    <span className="font-semibold text-foreground">
                      {visibleSelected.length === 1
                        ? '1 elegida'
                        : `${String(visibleSelected.length)} elegidas`}
                    </span>{' '}
                    · {formatQtyAsIs(chosenKg.toFixed(3), 'kg')} · ≈{' '}
                    {formatQtyAsIs(chosenMeters.toFixed(1), 'm')}
                    {chosenSealed.length > 0 && (
                      <>
                        {' '}
                        · {chosenSealed.length === 1 ? 'la' : 'las'}{' '}
                        {chosenSealed.map((c) => c.code).join(', ')}{' '}
                        {chosenSealed.length === 1
                          ? 'está sellada: se abre al montarla'
                          : 'están selladas: se abren al montarlas'}
                      </>
                    )}
                  </>
                )}
                {hiddenSelected > 0 && (
                  <span className="text-tone-warning-foreground">
                    {' '}
                    ·{' '}
                    {hiddenSelected === 1
                      ? '1 marcada queda'
                      : `${String(hiddenSelected)} marcadas quedan`}{' '}
                    fuera de la búsqueda y no se monta{hiddenSelected === 1 ? '' : 'n'}
                  </span>
                )}
              </p>
              <div className="flex gap-2">
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
                    visibleSelected.length === 0
                      ? `Montar en ${orderCode}`
                      : visibleSelected.length === 1
                        ? `Montar la bobina elegida en ${orderCode}`
                        : `Montar las ${String(visibleSelected.length)} bobinas elegidas en ${orderCode}`
                  }
                  disabled={visibleSelected.length === 0 || overLimit || pending}
                  onClick={() => {
                    mount(visibleSelected);
                  }}
                >
                  {visibleSelected.length === 0
                    ? 'Montar'
                    : visibleSelected.length === 1
                      ? 'Montar la bobina'
                      : `Montar las ${String(visibleSelected.length)}`}
                </Button>
              </div>
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
  physicalKg,
  pending,
  onReason,
  onPhysicalKg,
  onBack,
  onConfirm,
}: {
  coil: RoofingCoilOptionDto;
  reason: string;
  physicalKg: string;
  pending: boolean;
  onReason: (value: string) => void;
  onPhysicalKg: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const adjustment = coil.closeAdjustment;
  // cc29 (D-466): la terminada en 0 pide su peso físico; hasta el peso con que entró.
  const physicalOk =
    !coil.needsPhysicalKg ||
    (/^\d+(\.\d{1,3})?$/.test(physicalKg.trim()) &&
      new Decimal(physicalKg.trim()).gt(0) &&
      new Decimal(physicalKg.trim()).lte(coil.weightKg));
  return (
    <div className="grid gap-3">
      <div
        role="alert"
        className="rounded-lg border border-tone-warning-foreground/30 bg-tone-warning p-3 text-sm"
      >
        {coil.needsPhysicalKg ? (
          <>
            <span className="font-mono font-medium">{coil.code}</span> está terminada con el kardex
            en 0.
          </>
        ) : adjustment === null ? (
          <>
            <span className="font-mono font-medium">{coil.code}</span> está terminada sin un ajuste
            de cierre pendiente: reabrirla no mueve el kardex.
          </>
        ) : (
          <>
            <span className="font-mono font-medium">{coil.code}</span> terminada con ajuste de{' '}
            {formatQtyAsIs(adjustment.qtyKg, 'kg')} (
            {adjustment.kind === 'SHORTAGE' ? 'faltante' : 'sobrante'}) — reabrirla revierte el
            ajuste: {adjustment.kind === 'SHORTAGE' ? 'vuelven al kardex' : 'salen del kardex'}{' '}
            {formatQtyAsIs(adjustment.qtyKg, 'kg')} con un asiento compensatorio. Al terminarla de
            nuevo se calcula un ajuste nuevo con el saldo real.
          </>
        )}{' '}
        {coil.needsPhysicalKg ? (
          <>
            {' '}
            El kardex la da por consumida: pesa el rollo y declara cuánto queda. Esos kilos entran
            al kardex como sobrante (con el costo del sobrante de un cierre) y la orden los monta.
            Si bajas la bobina sin usarla, el sobrante se deshace.
          </>
        ) : (
          <>Queda montada en esta orden con {formatQtyAsIs(coil.availableKg, 'kg')}.</>
        )}
      </div>
      <FilmOpenNotice
        coils={[{ code: coil.code, status: 'OPEN', film: coil.film }]}
        className="rounded-lg bg-tone-warning p-3 text-sm text-tone-warning-foreground"
      />
      {coil.needsPhysicalKg && (
        <div className="grid gap-1.5">
          <Label htmlFor={`peso-fisico-${coil.coilId}`}>Peso físico del rollo (kg)</Label>
          <Input
            id={`peso-fisico-${coil.coilId}`}
            aria-label={`Peso físico de ${coil.code}`}
            inputMode="decimal"
            value={physicalKg}
            onChange={(e) => {
              onPhysicalKg(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Hasta {formatQtyAsIs(coil.weightKg, 'kg')}, el peso con que entró.
          </p>
        </div>
      )}
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
          disabled={reason.trim().length < 3 || !physicalOk || pending}
          onClick={onConfirm}
        >
          Reabrir y montar
        </Button>
      </DialogFooter>
    </div>
  );
}
