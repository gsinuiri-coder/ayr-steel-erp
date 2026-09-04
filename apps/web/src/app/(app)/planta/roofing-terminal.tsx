'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MAX_ORDER_STRIPS,
  ROOFING_THICKNESS_TOLERANCE_MM,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  PRODUCTION_ORDER_STATUS_LABELS,
  describePieces,
  piecesCount,
  piecesMeters,
  toDecimal,
  Unit,
  type ProductionOrderDto,
  type ReservationDto,
  type RoofingCoilOptionDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { ReasonDialog } from '@/components/reason-dialog';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidateProduction } from '@/lib/production-queries';
import { EMPTY_PIECE_ROW, mmToMeters, parsePieceRows, type PieceRow } from '@/lib/pieces';

/**
 * Rama de coberturas de la terminal de planta (RF-39 aplicado a RF-30..RF-33).
 *
 * Mobile-first como el resto de `/planta`: el operario la usa de pie, con guantes, en una
 * tablet. La diferencia con la rama de drywall es lo que se captura — largos en vez de
 * piezas— y lo que se declara al cerrar: los kilos que la bobina consumió de verdad (D-089).
 */

/** Una fila del editor de largos: metros a la vista, milímetros hacia el API (D-003). */
type LengthRow = PieceRow;

const EMPTY_ROW = EMPTY_PIECE_ROW;

// ---------------------------------------------------------------------------
// Editor de largos: se usa al reportar y al ajustar el plan de corte
// ---------------------------------------------------------------------------

export function LengthEditor({
  rows,
  onChange,
  idPrefix,
  disabled,
}: {
  rows: LengthRow[];
  onChange: (rows: LengthRow[]) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<LengthRow>) => {
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  };

  return (
    <div className="grid gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="grid flex-1 gap-1">
            {i === 0 && <Label htmlFor={`${idPrefix}-largo-${String(i)}`}>Largo (m)</Label>}
            <Input
              id={`${idPrefix}-largo-${String(i)}`}
              aria-label={`Largo ${String(i + 1)} en metros`}
              inputMode="decimal"
              className="h-12 text-lg"
              placeholder="4.20"
              disabled={disabled}
              value={row.lengthM}
              onChange={(e) => {
                set(i, { lengthM: e.target.value });
              }}
            />
          </div>
          <div className="grid w-28 gap-1">
            {i === 0 && <Label htmlFor={`${idPrefix}-cant-${String(i)}`}>Planchas</Label>}
            <Input
              id={`${idPrefix}-cant-${String(i)}`}
              aria-label={`Planchas del largo ${String(i + 1)}`}
              inputMode="numeric"
              className="h-12 text-lg"
              placeholder="3"
              disabled={disabled}
              value={row.qty}
              onChange={(e) => {
                set(i, { qty: e.target.value });
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-12"
            aria-label={`Quitar el largo de la fila ${String(i + 1)}`}
            disabled={disabled ?? rows.length === 1}
            onClick={() => {
              onChange(rows.length === 1 ? [EMPTY_ROW] : rows.filter((_, j) => j !== i));
            }}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="h-12 justify-self-start"
        disabled={disabled}
        onClick={() => {
          onChange([...rows, EMPTY_ROW]);
        }}
      >
        Agregar otro largo
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tarjeta del selector: los pedidos de coberturas que esperan producción
// ---------------------------------------------------------------------------

/**
 * D-084: una OP de coberturas no se crea eligiendo un producto, se crea eligiendo el
 * **pedido** que viene a cumplir. La lista son las reservas activas sobre bobina, que es
 * exactamente lo que un pedido de coberturas promete antes de fabricarse.
 */
export function RoofingPickerCard({ onSelect }: { onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const reservations = useQuery({
    queryKey: ['reservations', 'ACTIVE'],
    queryFn: () => api<ReservationDto[]>('/sales/reservations?status=ACTIVE'),
  });

  const create = useMutation({
    mutationFn: (reservationId: string) =>
      api<ProductionOrderDto>('/production/roofing', {
        method: 'POST',
        body: { reservationId },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada con el plan de corte del pedido`);
      invalidateProduction(queryClient);
      onSelect(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  // Solo las que prometen material de una bobina: una línea atendida con stock no tiene
  // nada que fabricar, y el API la rechaza por el mismo motivo.
  const pending = (reservations.data ?? []).filter(
    (r) => r.itemType === 'COIL' && r.productionOrderId === null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Coberturas por fabricar</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Una orden de coberturas nace del pedido y copia sus largos como plan de corte, que puedes
          ajustar antes y durante la corrida (RF-31, D-084).
        </p>
        {reservations.isPending && <Skeleton className="h-16 w-full" />}
        {reservations.isError && (
          <p className="text-sm text-destructive">No se pudieron cargar los pedidos pendientes.</p>
        )}
        {reservations.isSuccess && pending.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hay pedidos de coberturas esperando producción.
          </p>
        )}
        {pending.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div>
              <div className="font-mono font-medium">{r.salesOrderCode}</div>
              <div className="text-sm">{r.customerName}</div>
              <div className="text-xs text-muted-foreground">
                {r.itemName} · reserva {formatQty(r.qty, r.unit)} de {r.itemLabel}
              </div>
            </div>
            <Button
              className="h-12"
              aria-label={`Crear la orden del pedido ${r.salesOrderCode}`}
              disabled={create.isPending}
              onClick={() => {
                create.mutate(r.id);
              }}
            >
              Crear orden
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// La terminal
// ---------------------------------------------------------------------------

export function RoofingTerminal({
  order: o,
  onBack,
}: {
  order: ProductionOrderDto;
  onBack: () => void;
}) {
  const id = o.id;
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<LengthRow[]>([EMPTY_ROW]);
  const [coilId, setCoilId] = useState('');
  const [closing, setClosing] = useState(false);
  const [consumedKg, setConsumedKg] = useState('');
  const [editingPlan, setEditingPlan] = useState(false);
  const [planRows, setPlanRows] = useState<LengthRow[]>([EMPTY_ROW]);

  const isLive = o.status === 'DRAFT' || o.status === 'IN_PROGRESS';
  const liveCoils = o.consumptions.filter((c) => c.releasedAt === null);

  const coils = useQuery({
    queryKey: ['roofing-coils', o.productId, o.reservationId],
    queryFn: () =>
      api<RoofingCoilOptionDto[]>(
        `/production/roofing/coils?productId=${o.productId}${o.reservationId ? `&reservationId=${o.reservationId}` : ''}`,
      ),
    enabled: isLive,
  });

  const invalidate = () => {
    invalidateProduction(queryClient, id);
    void queryClient.invalidateQueries({ queryKey: ['roofing-coils'] });
  };

  const mount = useMutation({
    mutationFn: (coil: string) =>
      api<ProductionOrderDto>(`/production/roofing/${id}/coils`, {
        method: 'POST',
        body: { coilId: coil },
      }),
    onSuccess: () => {
      toast.success('Bobina montada en la roladora');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo montar la bobina'),
  });

  const release = useMutation({
    mutationFn: (consumptionId: string) =>
      api<ProductionOrderDto>(`/production/roofing/${id}/coils/${consumptionId}/release`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Bobina bajada de la orden');
      setCoilId('');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo bajar la bobina'),
  });

  const report = useMutation({
    mutationFn: (pieces: RoofingPieceDto[]) =>
      api<ProductionOrderDto>(`/production/roofing/${id}/report`, {
        method: 'POST',
        body: {
          pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
          ...(coilId ? { coilId } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('Planchas reportadas y reservadas para el pedido');
      setRows([EMPTY_ROW]);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudieron reportar las planchas'),
  });

  const savePlan = useMutation({
    mutationFn: (pieces: RoofingPieceDto[]) =>
      api<ProductionOrderDto>(`/production/roofing/${id}/plan`, {
        method: 'PUT',
        body: { items: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })) },
      }),
    onSuccess: () => {
      toast.success('Plan de corte actualizado');
      setEditingPlan(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar el plan'),
  });

  const close = useMutation({
    mutationFn: (reason?: string) =>
      api<ProductionOrderDto>(`/production/roofing/${id}/close`, {
        method: 'POST',
        body: {
          ...(consumedKg.trim() ? { consumedKg: consumedKg.trim() } : {}),
          ...(reason ? { reason } : {}),
        },
      }),
    onSuccess: (updated) => {
      toast.success(`Orden cerrada: ${formatQty(updated.scrapKg ?? '0.000', 'kg')} de despunte`);
      setClosing(false);
      setConsumedKg('');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cerrar la orden'),
  });

  const parsed = parsePieceRows(rows);
  const pieces = parsed.ok ? parsed.pieces : null;
  const parsedPlan = parsePieceRows(planRows);
  const reportedKg = o.reports
    .filter((r) => r.revertedAt === null)
    .reduce((acc, r) => acc.plus(new Decimal(r.theoreticalKg)), new Decimal(0));
  const declared = consumedKg.trim();
  // Las dos cotas que el API comprueba: no menos de lo que las planchas ya consumieron, ni
  // más de lo que la orden tiene montado. La segunda es un dato que la pantalla ya tiene, y
  // descubrirla con un 400 en el cierre es la peor forma de enterarse.
  const mountedKg = liveCoils.reduce((acc, c) => acc.plus(new Decimal(c.remainingKg)), reportedKg);
  const declaredValid =
    declared === '' ||
    (/^\d+(\.\d{1,3})?$/.test(declared) &&
      toDecimal(declared).gte(reportedKg) &&
      toDecimal(declared).lte(mountedKg));
  const scrapKg =
    declared === '' || !declaredValid ? new Decimal(0) : toDecimal(declared).minus(reportedKg);
  const needsReason =
    declared !== '' &&
    declaredValid &&
    toDecimal(declared).gt(0) &&
    scrapKg.div(toDecimal(declared)).gt(MAX_SCRAP_RATIO_WITHOUT_REASON);
  const madeToMeasure = o.productUnit === Unit.MTR;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{o.code}</h1>
            <Badge variant={o.status === 'IN_PROGRESS' ? 'default' : 'secondary'}>
              {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
            </Badge>
            <Badge variant="outline">Coberturas</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {o.productSku} · {o.productName}
            {o.salesOrderCode && (
              <>
                {' '}
                · {o.salesOrderCode} · {o.customerName}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="h-12" onClick={onBack}>
            Otra orden
          </Button>
          <Button variant="outline" className="h-12" asChild>
            <Link href={`/produccion/${o.id}`}>Ver detalle</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <BigStat
          label={madeToMeasure ? 'Metros buenos' : 'Planchas buenas'}
          value={madeToMeasure ? `${o.metersReported ?? '0.000'} m` : String(o.piecesReported)}
        />
        <BigStat
          label={madeToMeasure ? 'Planchas' : 'Plan de corte'}
          value={madeToMeasure ? String(o.piecesReported) : String(piecesCount(o.items))}
        />
        <BigStat label="Consumido (teórico)" value={formatQty(reportedKg.toFixed(3), 'kg')} />
        <BigStat label="Bobinas montadas" value={String(liveCoils.length)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan de corte del pedido</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {o.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">La orden no tiene plan de corte.</p>
          ) : (
            <p className="text-lg">
              {describePieces(o.items)}{' '}
              <span className="text-sm text-muted-foreground">
                ({piecesCount(o.items)} planchas · {piecesMeters(o.items).toFixed(3)} m)
              </span>
            </p>
          )}
          {isLive && !editingPlan && (
            <Button
              variant="outline"
              className="h-12 justify-self-start"
              onClick={() => {
                setPlanRows(
                  o.items.length === 0
                    ? [EMPTY_ROW]
                    : o.items.map((p) => ({
                        lengthM: mmToMeters(p.lengthMm),
                        qty: String(p.qty),
                      })),
                );
                setEditingPlan(true);
              }}
            >
              Ajustar el plan
            </Button>
          )}
          {editingPlan && (
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">
                El plan es una intención: lo que mueve inventario son los largos que reportes.
              </p>
              <LengthEditor rows={planRows} onChange={setPlanRows} idPrefix="plan" />
              {!parsedPlan.ok && <p className="text-sm text-destructive">{parsedPlan.reason}</p>}
              <div className="flex gap-2">
                <Button
                  className="h-12"
                  disabled={!parsedPlan.ok || savePlan.isPending}
                  onClick={() => {
                    if (parsedPlan.ok) savePlan.mutate(parsedPlan.pieces);
                  }}
                >
                  {savePlan.isPending ? 'Guardando…' : 'Guardar plan'}
                </Button>
                <Button
                  variant="outline"
                  className="h-12"
                  onClick={() => {
                    setEditingPlan(false);
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isLive && liveCoils.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reportar largos rolados</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {liveCoils.length > 1 && (
              <div className="grid gap-2">
                <Label htmlFor="roofing-bobina">¿De qué bobina salieron?</Label>
                <select
                  id="roofing-bobina"
                  className="h-12 rounded-md border bg-background px-3"
                  value={coilId}
                  onChange={(e) => {
                    setCoilId(e.target.value);
                  }}
                >
                  <option value="">Elige la bobina</option>
                  {liveCoils.map((c) => (
                    <option key={c.coilId} value={c.coilId}>
                      {c.coilCode} — pendiente {c.remainingKg} kg
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  El kilo consumido sale del ancho y el espesor de esa bobina (D-047).
                </p>
              </div>
            )}
            <LengthEditor rows={rows} onChange={setRows} idPrefix="reporte" />
            <p className="text-sm text-muted-foreground">
              {parsed.ok
                ? `${String(piecesCount(parsed.pieces))} planchas · ${piecesMeters(parsed.pieces).toFixed(3)} m`
                : parsed.reason}
            </p>
            <Button
              className="h-16 text-lg"
              disabled={
                pieces === null || report.isPending || (liveCoils.length > 1 && coilId === '')
              }
              onClick={() => {
                if (pieces) report.mutate(pieces);
              }}
            >
              {report.isPending ? 'Registrando…' : 'Reportar planchas'}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bobinas montadas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {liveCoils.length === 0 && (
            <p className="text-sm text-muted-foreground">
              La orden no tiene ninguna bobina montada todavía.
            </p>
          )}
          {liveCoils.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <div className="font-mono font-medium">{c.coilCode}</div>
                <div className="text-sm text-muted-foreground">
                  {c.widthMm} mm · pendiente {formatQty(c.remainingKg, 'kg')} de{' '}
                  {formatQty(c.assignedKg, 'kg')}
                </div>
              </div>
              {isLive && new Decimal(c.consumedKg).lte(0) && (
                <Button
                  variant="outline"
                  className="h-12"
                  aria-label={`Bajar la bobina ${c.coilCode}`}
                  disabled={release.isPending}
                  onClick={() => {
                    release.mutate(c.id);
                  }}
                >
                  Bajar
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {isLive && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Montar una bobina</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {coils.isPending && <Skeleton className="h-16 w-full" />}
            {coils.isError && (
              <p className="text-sm text-destructive">
                No se pudieron cargar las bobinas disponibles.
              </p>
            )}
            {coils.isSuccess && coils.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hay bobinas libres de {o.bom.inputThicknessMm} mm (±
                {ROOFING_THICKNESS_TOLERANCE_MM}) del color de {o.productSku}. Una bobina en corte
                tercerizado, montada en otra orden o prometida a otro pedido tampoco aparece acá.
              </p>
            )}
            {liveCoils.length >= MAX_ORDER_STRIPS && (
              <p className="text-sm text-destructive">
                La orden ya tiene las {MAX_ORDER_STRIPS} bobinas que admite a la vez.
              </p>
            )}
            {coils.data?.map((c) => (
              <div
                key={c.coilId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <div className="font-mono font-medium">{c.code}</div>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <ColorSwatch
                      color={
                        c.colorName && c.colorHex
                          ? { name: c.colorName, hexColor: c.colorHex }
                          : null
                      }
                    />
                    <span>
                      · {c.widthMm} mm × {c.thicknessMm} mm · {formatQty(c.availableKg, 'kg')} ·
                      alcanza para {c.estimatedMeters} m
                    </span>
                  </div>
                </div>
                <Button
                  className="h-12"
                  aria-label={`Montar la bobina ${c.code}`}
                  disabled={mount.isPending || liveCoils.length >= MAX_ORDER_STRIPS}
                  onClick={() => {
                    mount.mutate(c.coilId);
                  }}
                >
                  Montar
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {o.status === 'IN_PROGRESS' && o.piecesReported > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cerrar la corrida</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="roofing-consumido">Kilos que consumió la bobina (opcional)</Label>
              <Input
                id="roofing-consumido"
                inputMode="decimal"
                className="h-12 text-lg"
                placeholder={reportedKg.toFixed(3)}
                value={consumedKg}
                onChange={(e) => {
                  setConsumedKg(e.target.value);
                }}
              />
              <p className="text-sm text-muted-foreground">
                Sin este dato se asume que la bobina consumió exactamente los{' '}
                {formatQty(reportedKg.toFixed(3), 'kg')} teóricos de las planchas reportadas. La
                diferencia sale como despunte; el resto de la bobina vuelve al almacén.
                {declared !== '' && !declaredValid && (
                  <span className="text-destructive">
                    {' '}
                    Tiene que estar entre {formatQty(reportedKg.toFixed(3), 'kg')} —lo que las
                    planchas ya consumieron— y {formatQty(mountedKg.toFixed(3), 'kg')}, que es lo
                    que la orden tiene montado.
                  </span>
                )}
                {scrapKg.gt(0) && declaredValid && (
                  <> Despunte: {formatQty(scrapKg.toFixed(3), 'kg')}.</>
                )}
              </p>
            </div>
            <Button
              className="h-16 text-lg"
              disabled={close.isPending || !declaredValid}
              onClick={() => {
                // Con mucho despunte, cerrar es una baja de inventario y el API pide motivo
                // (D-089): se lo pedimos acá en vez de gastar un 400.
                if (needsReason) setClosing(true);
                else close.mutate(undefined);
              }}
            >
              {close.isPending ? 'Cerrando…' : 'Cerrar orden'}
            </Button>
          </CardContent>
        </Card>
      )}

      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title="Cerrar con despunte alto"
        description={`Se declaran ${formatQty(declared || '0', 'kg')} consumidos y las planchas reportadas representan ${formatQty(reportedKg.toFixed(3), 'kg')}: la diferencia sale del inventario como merma y su costo se reparte entre el producto bueno. Explica por qué.`}
        confirmLabel="Cerrar la orden"
        pending={close.isPending}
        onConfirm={(reason) => {
          close.mutate(reason);
        }}
      />
    </>
  );
}

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}
