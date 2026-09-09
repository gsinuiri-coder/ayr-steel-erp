'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MAX_ORDER_STRIPS,
  MAX_ORDER_TABS,
  ROOFING_THICKNESS_TOLERANCE_MM,
  Role,
  Unit,
  describePieces,
  piecesCount,
  piecesFromPlanMeters,
  piecesTheoreticalKg,
  roofingConsumptionDeviation,
  toDecimal,
  type Decimal,
  type ProductionOrderDto,
  type RawMaterialWarningDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * El espacio de producción de un pedido (D-155).
 *
 * Reemplaza a la tanda de D-147, que quedó a mitad de camino: dejaba transcribir los metros
 * de N órdenes de una sentada, pero **no montaba la bobina**, así que el encargado tenía que
 * entrar orden por orden a la terminal para montar y recién después volver acá a reportar.
 * Dos pantallas para una sola tarea, y el guardado todo-o-nada de la tanda encima obligaba a
 * rehacer las ocho filas cuando la séptima tenía un número mal tipeado.
 *
 * Acá una orden es una **pestaña** y cada pestaña tiene su ciclo completo: montar o cambiar
 * la bobina, ver lo que el plan pide y lo que ya salió, y reportar. El guardado es **por
 * orden** —montar ya lo era— y cada uno sigue siendo atómico del lado del API: el reporte y
 * su kardex entran en una transacción vía `InventoryService.record()`.
 *
 * Nada de lo que esta pantalla muestra bloquea salvo lo que el API también rechaza: el tope
 * de metros del plan (D-146) y el material montado. Las desviaciones del kilo declarado y el
 * faltante del agregado de materia prima **avisan** (D-154) — quien está en la roladora no
 * puede anular el pedido de otro cliente, y cortarle la corrida solo lograba que el material
 * rolado no quedara registrado.
 */

/** §3.4: producción es de ADMINISTRADOR y SUPERVISOR_PLANTA, igual que `/planta`. */
const PLANT_ROLES = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA] as const;

/** Lo que se está por reportar en una orden. Vive **en el padre**, indexado por orden. */
interface OrderDraft {
  /** Lo tipeado en el campo de salida: metros o planchas según la unidad del producto. */
  output: string;
  consumedKg: string;
  coilId: string;
}

const EMPTY_DRAFT: OrderDraft = { output: '', consumedKg: '', coilId: '' };

/**
 * Lo que la última operación de una orden dejó dicho, y que sigue a la vista después de
 * guardar. Los dos son avisos (D-154) y ninguno bloquea nada.
 */
interface SavedNotes {
  /** Faltantes del agregado que devolvió el API. */
  pool: RawMaterialWarningDto[];
  /**
   * La desviación del kg declarado. La calcula la pantalla con la misma función del API, y
   * hay que **retenerla**: al guardar se limpia el campo de kilos, así que el ⚠ que se veía
   * mientras se tipeaba desaparecía justo cuando pasó a ser un hecho registrado.
   */
  note: string | null;
}

const NO_NOTES: SavedNotes = { pool: [], note: null };

export function ProducirView() {
  const params = useSearchParams();
  const salesOrderId = params.get('pedido');
  const [activeId, setActiveId] = useState<string | null>(null);
  /** D-124: día de negocio de todo lo que se reporte en esta sesión. Solo lo ve un admin. */
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  /**
   * Los borradores y los avisos viven acá y no en la pestaña **a propósito**: con estado
   * local, saltar a otra orden para verificar de qué bobina salió algo y volver borraba lo
   * transcripto sin ningún aviso. La tanda de D-147 tenía las N filas a la vista justamente
   * por eso, y esa propiedad no se puede perder al pasar a pestañas.
   */
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>({});
  const [saved, setSaved] = useState<Record<string, SavedNotes>>({});

  const orders = useQuery({
    queryKey: ['roofing-batch', salesOrderId],
    queryFn: () =>
      api<RoofingBatchOrderDto[]>(
        `/production/roofing/batch${salesOrderId === null ? '' : `?salesOrderId=${salesOrderId}`}`,
      ),
  });

  const rows = useMemo(() => orders.data ?? [], [orders.data]);
  // La pestaña activa se elige sola la primera vez y se recompone si la orden que estaba
  // abierta desaparece de la lista (se cerró, se anuló). Sin esto, cerrar la última orden
  // dejaba el panel en blanco sin decir por qué.
  useEffect(() => {
    if (rows.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId === null || !rows.some((r) => r.orderId === activeId)) {
      setActiveId(rows[0]?.orderId ?? null);
    }
  }, [rows, activeId]);

  const active = rows.find((r) => r.orderId === activeId) ?? null;
  const done = rows.filter((r) => stateOf(r) === 'reportada').length;
  const asList = rows.length > MAX_ORDER_TABS;
  // Solo con un pedido acotado: sin `?pedido=` la lista mezcla clientes, y colgar el de la
  // primera orden del subtítulo lo haría pasar por el de todas.
  const customerName = salesOrderId === null ? null : (rows[0]?.customerName ?? null);
  const salesOrderCode = salesOrderId === null ? null : (rows[0]?.salesOrderCode ?? null);

  return (
    <RoleGate allow={PLANT_ROLES}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              {salesOrderId === null ? 'Producir' : `Producir ${salesOrderCode ?? 'el pedido'}`}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {salesOrderId === null
                ? 'Todas las órdenes de coberturas abiertas. Cada una monta su bobina y reporta lo suyo por separado.'
                : 'Una pestaña por orden del pedido. Monta la bobina y reporta sin salir de acá; cada orden se guarda por su cuenta.'}
              {customerName !== null && <> · {customerName}</>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {salesOrderId !== null && (
              <Button variant="outline" className="h-12" asChild>
                <Link href="/planta/producir">Todas las órdenes abiertas</Link>
              </Button>
            )}
            <Button variant="outline" className="h-12" asChild>
              <Link href="/planta">Terminal de planta</Link>
            </Button>
          </div>
        </div>

        {orders.isPending && <Skeleton className="h-64 w-full" />}
        {orders.isError && (
          <Alert variant="destructive">
            <AlertDescription>No se pudieron cargar las órdenes abiertas.</AlertDescription>
          </Alert>
        )}
        {orders.isSuccess && rows.length === 0 && (
          <Alert>
            <AlertDescription>
              {salesOrderId === null
                ? 'No hay ninguna orden de coberturas abierta. Se crean desde el pedido o desde la terminal de planta.'
                : 'Este pedido no tiene órdenes de coberturas abiertas. Genéralas desde el detalle del pedido.'}
            </AlertDescription>
          </Alert>
        )}

        {rows.length > 0 && (
          <>
            <Progress done={done} total={rows.length} />
            <div
              className={
                asList
                  ? 'grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr] lg:items-start'
                  : 'grid gap-4'
              }
            >
              <OrderPicker rows={rows} activeId={activeId} asList={asList} onSelect={setActiveId} />
              {active && (
                <OrderPanel
                  order={active}
                  asList={asList}
                  draft={drafts[active.orderId] ?? EMPTY_DRAFT}
                  notes={saved[active.orderId] ?? NO_NOTES}
                  operationDate={operationDate}
                  onOperationDate={setOperationDate}
                  onDraft={(patch) => {
                    setDrafts((prev) => ({
                      ...prev,
                      [active.orderId]: { ...EMPTY_DRAFT, ...prev[active.orderId], ...patch },
                    }));
                  }}
                  onNotes={(next) => {
                    setSaved((prev) => ({ ...prev, [active.orderId]: next }));
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </RoleGate>
  );
}

// ---------------------------------------------------------------------------
// Estado de una orden, que es lo que la pestaña tiene que decir de un vistazo
// ---------------------------------------------------------------------------

type OrderState = 'sin-bobina' | 'lista' | 'reportada';

const STATE_LABELS: Record<OrderState, string> = {
  'sin-bobina': 'Sin bobina',
  lista: 'Lista',
  reportada: 'Reportada',
};

/**
 * El estado va en este orden y no en otro: "reportada" gana aunque la bobina ya se haya
 * bajado —el plan está cubierto y no hay nada más que hacer—, y "sin bobina" es lo que
 * separa una orden que se puede reportar de una que primero necesita material.
 */
function stateOf(order: RoofingBatchOrderDto): OrderState {
  if (toDecimal(order.remainingMeters).lte(0)) return 'reportada';
  return order.coils.length === 0 ? 'sin-bobina' : 'lista';
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <Card>
      <CardContent className="grid gap-2 pt-6">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {done} de {total}{' '}
            {total === 1 ? 'orden con su plan cubierto' : 'órdenes con su plan cubierto'}
          </span>
          <span className="tabular-nums text-muted-foreground">{pct} %</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Órdenes reportadas"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${String(pct)}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Pestañas hasta `MAX_ORDER_TABS`, lista lateral por encima. El corte no es estético: con
 * ocho pestañas en una tablet hay que **buscar** la orden en vez de verla, que es
 * exactamente el trabajo que esta pantalla vino a sacar del medio.
 *
 * Con la forma de lista deja de anunciarse como `tablist`: la semántica de pestañas trae
 * expectativas de teclado (flechas para moverse entre ellas) que una lista lateral no
 * cumple, y anunciarla igual sería mentirle al lector de pantalla.
 */
function OrderPicker({
  rows,
  activeId,
  asList,
  onSelect,
}: {
  rows: readonly RoofingBatchOrderDto[];
  activeId: string | null;
  asList: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role={asList ? undefined : 'tablist'}
      aria-label="Órdenes del pedido"
      className={asList ? 'grid gap-2' : 'flex flex-wrap gap-2'}
    >
      {rows.map((row) => {
        const state = stateOf(row);
        const selected = row.orderId === activeId;
        return (
          <button
            key={row.orderId}
            type="button"
            id={`tab-${row.orderId}`}
            role={asList ? undefined : 'tab'}
            aria-selected={asList ? undefined : selected}
            aria-controls={`panel-${row.orderId}`}
            aria-current={asList ? selected : undefined}
            onClick={() => {
              onSelect(row.orderId);
            }}
            className={`rounded-lg border px-3 py-2 text-left ${
              selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'
            } ${asList ? 'w-full' : ''}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium">{row.code}</span>
              <StateBadge state={state} />
            </div>
            <div className="text-xs text-muted-foreground">
              {row.productSku} · faltan {row.remainingMeters} m
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StateBadge({ state }: { state: OrderState }) {
  return (
    <Badge
      variant={state === 'reportada' ? 'secondary' : state === 'lista' ? 'default' : 'outline'}
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// La pestaña: el ciclo completo de UNA orden
// ---------------------------------------------------------------------------

function OrderPanel({
  order,
  asList,
  draft,
  notes,
  operationDate,
  onOperationDate,
  onDraft,
  onNotes,
}: {
  order: RoofingBatchOrderDto;
  /** El picker dejó de ser pestañas; el panel tiene que dejar de ser `tabpanel` con él. */
  asList: boolean;
  draft: OrderDraft;
  notes: SavedNotes;
  operationDate: string | undefined;
  onOperationDate: (value: string | undefined) => void;
  onDraft: (patch: Partial<OrderDraft>) => void;
  onNotes: (next: SavedNotes) => void;
}) {
  const queryClient = useQueryClient();
  const [mounting, setMounting] = useState(false);

  const invalidate = () => {
    invalidateProduction(queryClient, order.orderId);
    void queryClient.invalidateQueries({ queryKey: ['roofing-coils'] });
  };

  const options = useQuery({
    queryKey: ['roofing-coils', order.productId, order.reservationId],
    queryFn: () =>
      api<RoofingCoilOptionDto[]>(
        `/production/roofing/coils?productId=${order.productId}` +
          (order.reservationId === null ? '' : `&reservationId=${order.reservationId}`),
      ),
  });

  const mount = useMutation({
    mutationFn: (id: string) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/coils`, {
        method: 'POST',
        body: { coilId: id },
      }),
    onSuccess: (updated) => {
      toast.success('Bobina montada en la roladora');
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: null });
      // Se cierra acá y no al hacer click: si el montaje falla —otra orden se llevó la
      // bobina entre el listado y el botón— el selector tiene que seguir abierto para
      // poder elegir otra.
      setMounting(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo montar la bobina'),
  });

  const release = useMutation({
    mutationFn: (consumptionId: string) =>
      api<ProductionOrderDto>(
        `/production/roofing/${order.orderId}/coils/${consumptionId}/release`,
        {
          method: 'POST',
        },
      ),
    onSuccess: () => {
      toast.success('Bobina bajada de la orden');
      onDraft({ coilId: '' });
      // El aviso hablaba del material que esta orden retenía; con la bobina abajo describe
      // un estado que ya no existe.
      onNotes(NO_NOTES);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo bajar la bobina'),
  });

  const resolved = resolveDraft(order, draft);

  const report = useMutation({
    mutationFn: ({
      pieces,
      confirmBackdate,
    }: {
      pieces: RoofingPieceDto[];
      confirmBackdate: boolean;
    }) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/report`, {
        method: 'POST',
        body: {
          pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
          ...(resolved.coil ? { coilId: resolved.coil.coilId } : {}),
          ...(draft.consumedKg.trim()
            ? { consumedKg: toDecimal(draft.consumedKg.trim()).toFixed(3) }
            : {}),
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
        },
      }),
    onSuccess: (updated) => {
      toast.success(`${order.code}: producción reportada`);
      // La desviación se guarda **antes** de limpiar el campo: es la misma cuenta que el API
      // acaba de dejar anotada en el reporte, y quien la produjo tiene que seguir viéndola.
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: resolved.deviation });
      onDraft({ output: '', consumedKg: '' });
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo reportar la producción'),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    if (resolved.pieces) await report.mutateAsync({ pieces: resolved.pieces, confirmBackdate });
  });

  const liveCoils = order.coils;
  const state = stateOf(order);
  const full = liveCoils.length >= MAX_ORDER_STRIPS;

  return (
    // Con la forma de lista, `tabpanel` sería un huérfano: no hay ningún `tablist` que lo
    // contenga y `aria-labelledby` apuntaría a un botón que ya no se anuncia como pestaña.
    // El rótulo se conserva en las dos formas; lo que cambia es solo el rol.
    <section
      role={asList ? undefined : 'tabpanel'}
      id={`panel-${order.orderId}`}
      aria-labelledby={`tab-${order.orderId}`}
      className="grid gap-4"
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono">{order.code}</span>
            <StateBadge state={state} />
            <span className="font-normal text-muted-foreground">
              {order.productSku} · {order.productName}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            <MiniStat label="ML del plan" value={`${order.planMeters} m`} />
            <MiniStat label="ML reportado" value={`${order.reportedMeters} m`} />
            <MiniStat
              label="ML restante"
              value={`${order.remainingMeters} m`}
              tone={toDecimal(order.remainingMeters).lte(0) ? 'alert' : 'strong'}
            />
            <MiniStat
              label="kg teórico del plan"
              value={resolved.planKg === null ? '—' : `${resolved.planKg.toFixed(3)} kg`}
              // Dos motivos distintos para el mismo guion, y confundirlos hacía que la
              // pantalla pidiera montar una bobina sobre una orden que tenía dos.
              hint={
                liveCoils.length === 0
                  ? 'Monta una bobina'
                  : resolved.coil === undefined
                    ? 'Elige la bobina'
                    : undefined
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {order.remainingPieces.length > 0
              ? `Faltan ${describePieces(order.remainingPieces)}`
              : 'El plan ya está cubierto.'}
            {' · '}
            <Link href={`/produccion/${order.orderId}`} className="underline">
              Ver el detalle de la orden
            </Link>
          </p>
        </CardContent>
      </Card>

      {(notes.pool.length > 0 || notes.note !== null) && (
        <Alert>
          <AlertDescription className="grid gap-1">
            {notes.note !== null && <span>⚠ {notes.note}</span>}
            {notes.pool.map((w, i) => (
              <span key={i}>⚠ {w.message}</span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bobina montada</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {liveCoils.length === 0 && (
            <p className="text-sm text-muted-foreground">
              La orden no tiene ninguna bobina montada: monta una para poder reportar.
            </p>
          )}
          {liveCoils.map((c) => (
            <div
              key={c.coilId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <div className="font-mono font-medium">{c.coilCode}</div>
                <div className="text-sm text-muted-foreground">
                  {c.widthMm} mm · pendiente {formatQty(c.remainingKg, 'kg')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {liveCoils.length > 1 && (
                  <Button
                    variant={resolved.coil?.coilId === c.coilId ? 'default' : 'outline'}
                    className="h-11"
                    aria-label={`Reportar desde la bobina ${c.coilCode}`}
                    onClick={() => {
                      onDraft({ coilId: c.coilId });
                    }}
                  >
                    {resolved.coil?.coilId === c.coilId ? 'Elegida' : 'Usar esta'}
                  </Button>
                )}
                {/* Una bobina que ya roló no se baja: hay que revertir esos reportes primero
                    (RF-33). El API dice lo mismo; apagar el botón evita gastar un 400. */}
                <Button
                  variant="outline"
                  className="h-11"
                  aria-label={`Bajar la bobina ${c.coilCode} de ${order.code}`}
                  disabled={release.isPending || toDecimal(c.consumedKg).gt(0)}
                  onClick={() => {
                    release.mutate(c.consumptionId);
                  }}
                >
                  {toDecimal(c.consumedKg).gt(0) ? 'Ya roló' : 'Bajar'}
                </Button>
              </div>
            </div>
          ))}

          {full && (
            <p className="text-sm text-destructive">
              La orden ya tiene las {MAX_ORDER_STRIPS} bobinas que admite a la vez: ciérrala o baja
              alguna antes de montar otra.
            </p>
          )}
          {!full && !mounting && liveCoils.length > 0 && (
            <Button
              variant="outline"
              className="h-11 justify-self-start"
              onClick={() => {
                setMounting(true);
              }}
            >
              Montar otra bobina
            </Button>
          )}
          {!full && (mounting || liveCoils.length === 0) && (
            <MountPicker
              order={order}
              options={options.data ?? []}
              loading={options.isPending}
              failed={options.isError}
              pending={mount.isPending}
              onMount={(id) => {
                mount.mutate(id);
              }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reportar lo que salió</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`salida-${order.orderId}`}>
                {resolved.inPieces ? 'Planchas nuevas' : 'ML nuevo'}
              </Label>
              <Input
                id={`salida-${order.orderId}`}
                aria-label={
                  resolved.inPieces
                    ? `Planchas nuevas de ${order.code}`
                    : `Metros nuevos de ${order.code}`
                }
                inputMode={resolved.inPieces ? 'numeric' : 'decimal'}
                className="h-12 text-lg"
                placeholder={resolved.inPieces ? '0' : '0.000'}
                disabled={liveCoils.length === 0 || report.isPending}
                value={draft.output}
                onChange={(e) => {
                  onDraft({ output: e.target.value });
                }}
              />
              {resolved.pieces && (
                <p className="text-xs text-muted-foreground">
                  {describePieces(resolved.pieces)}
                  {resolved.newKg !== null && <> · {resolved.newKg.toFixed(3)} kg teóricos</>}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`kg-${order.orderId}`}>kg consumido (opcional)</Label>
              <Input
                id={`kg-${order.orderId}`}
                aria-label={`Kilos consumidos de ${order.code}`}
                inputMode="decimal"
                className="h-12 text-lg"
                placeholder={resolved.newKg === null ? 'opcional' : resolved.newKg.toFixed(3)}
                disabled={liveCoils.length === 0 || report.isPending}
                value={draft.consumedKg}
                onChange={(e) => {
                  onDraft({ consumedKg: e.target.value });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Dato de planta: el kardex sale por el kilo teórico y el consumo real se reconcilia
                al cerrar.
              </p>
            </div>
          </div>

          {resolved.error !== null && <p className="text-sm text-destructive">{resolved.error}</p>}
          {resolved.deviation !== null && (
            <p className="text-sm text-amber-700 dark:text-amber-500">⚠ {resolved.deviation}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Button
              className="h-16 text-lg"
              disabled={resolved.pieces === null || resolved.error !== null || report.isPending}
              onClick={() => {
                void backdate.attempt();
              }}
            >
              {report.isPending ? 'Guardando…' : `Guardar ${order.code}`}
            </Button>
            <OperationDateField value={operationDate} onChange={onOperationDate} />
          </div>
        </CardContent>
      </Card>

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={report.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />
    </section>
  );
}

function MountPicker({
  order,
  options,
  loading,
  failed,
  pending,
  onMount,
}: {
  order: RoofingBatchOrderDto;
  options: readonly RoofingCoilOptionDto[];
  loading: boolean;
  failed: boolean;
  pending: boolean;
  onMount: (coilId: string) => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">Montar una bobina</p>
      {loading && <Skeleton className="h-16 w-full" />}
      {failed && (
        <p className="text-sm text-destructive">No se pudieron cargar las bobinas disponibles.</p>
      )}
      {!loading && !failed && options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No hay bobinas libres del color y el espesor de {order.productSku} (±
          {ROOFING_THICKNESS_TOLERANCE_MM} mm). Una bobina en corte tercerizado, montada en otra
          orden o prometida a otro pedido tampoco aparece acá.
        </p>
      )}
      {options.map((c) => (
        <div
          key={c.coilId}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div>
            <div className="font-mono font-medium">{c.code}</div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <ColorSwatch
                color={
                  c.colorName && c.colorHex ? { name: c.colorName, hexColor: c.colorHex } : null
                }
              />
              <span>
                · {c.widthMm} mm × {c.thicknessMm} mm · {formatQty(c.availableKg, 'kg')} · alcanza
                para {c.estimatedMeters} m
              </span>
            </div>
          </div>
          <Button
            className="h-11"
            aria-label={`Montar la bobina ${c.code} en ${order.code}`}
            disabled={pending}
            onClick={() => {
              onMount(c.coilId);
            }}
          >
            Montar
          </Button>
        </div>
      ))}
    </div>
  );
}

function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'alert' | 'strong';
}) {
  return (
    <div className="bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'alert'
            ? 'text-lg font-semibold tabular-nums text-destructive'
            : 'text-lg font-semibold tabular-nums'
        }
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lo que el borrador de una pestaña resuelve, con las funciones del API
// ---------------------------------------------------------------------------

interface ResolvedDraft {
  coil: RoofingBatchOrderDto['coils'][number] | undefined;
  planKg: Decimal | null;
  /**
   * D-140: una plancha de catálogo se cuenta en **planchas**, no en metros. La terminal ya
   * distinguía las dos unidades; capturar siempre metros acá hacía que escribir `3`
   * pensando en tres planchas de 3 m reportara **una**, sin ningún error.
   */
  inPieces: boolean;
  pieces: RoofingPieceDto[] | null;
  newKg: Decimal | null;
  /** Lo que el API también rechaza: el botón se apaga. */
  error: string | null;
  /** Lo que el API **acepta** y anota igual (D-154): se muestra y no bloquea. */
  deviation: string | null;
}

function resolveDraft(order: RoofingBatchOrderDto, draft: OrderDraft): ResolvedDraft {
  const coil =
    order.coils.length === 1 ? order.coils[0] : order.coils.find((c) => c.coilId === draft.coilId);
  const geometry =
    coil === undefined
      ? null
      : { widthMm: coil.widthMm, thicknessMm: coil.thicknessMm, densityFactor: coil.densityFactor };
  const planKg =
    geometry === null || order.planItems.length === 0
      ? null
      : piecesTheoreticalKg(geometry, order.planItems);
  // Una plancha de catálogo tiene un solo largo en su plan (`derivePiecesPlan` con el largo
  // del SKU): es lo que hace posible convertir planchas a metros sin ambigüedad. Un plan de
  // varios largos vuelve a capturarse en metros, que es la única forma de decirlo.
  const single = order.planItems.length === 1 ? order.planItems[0] : undefined;
  const inPieces = order.productUnit !== Unit.MTR && single !== undefined;

  const base: ResolvedDraft = {
    coil,
    planKg,
    inPieces,
    pieces: null,
    newKg: null,
    error: null,
    deviation: null,
  };

  const typed = draft.output.trim();
  if (typed === '') return base;
  if (order.coils.length === 0) {
    return { ...base, error: 'La orden no tiene ninguna bobina montada.' };
  }
  // Una orden sin plan de corte no se puede capturar por metros: los largos salen del plan.
  // El API responde exactamente esto; decir "quedan 0.000 m del plan" mandaría a corregir un
  // plan que no existe.
  if (order.planItems.length === 0) {
    return {
      ...base,
      error: 'La orden no tiene plan de corte: reporta sus largos desde la terminal de planta.',
    };
  }
  if (order.coils.length > 1 && coil === undefined) {
    return { ...base, error: 'Indica de qué bobina salieron.' };
  }

  let meters: string;
  if (inPieces) {
    if (!/^\d+$/.test(typed) || Number(typed) < 1) {
      return { ...base, error: 'Las planchas se cuentan en enteros mayores a cero.' };
    }
    // Regla dura 1: los milímetros no se operan con `number`, ni siquiera para derivar los
    // metros que después vuelve a repartir `piecesFromPlanMeters`.
    meters = toDecimal(single?.lengthMm ?? '0')
      .div(1000)
      .times(typed)
      .toFixed(3);
  } else {
    if (!/^\d+(\.\d{1,3})?$/.test(typed) || toDecimal(typed).lte(0)) {
      return { ...base, error: 'Los metros van con hasta tres decimales y mayores a cero.' };
    }
    meters = typed;
  }

  // D-146: el tope del plan se comprueba antes que el desglose, porque es el error que el
  // operario puede corregir sin entender nada de largos. Sigue siendo tope duro: producir de
  // más se resuelve ajustando el plan, no reportando por encima.
  if (toDecimal(meters).gt(toDecimal(order.remainingMeters))) {
    return {
      ...base,
      error: inPieces
        ? `Del plan quedan ${String(piecesCount(order.remainingPieces))} planchas: ajusta el plan de corte si de verdad hay que producir más.`
        : `Del plan quedan ${order.remainingMeters} m: ajusta el plan de corte si de verdad hay que producir más.`,
    };
  }

  const split = piecesFromPlanMeters(order.planItems, reportedOf(order), meters);
  if (!split.ok) return { ...base, error: split.reason };
  const pieces = split.pieces.map((p, i) => ({ lineNumber: i + 1, ...p }));
  const newKg = geometry === null ? null : piecesTheoreticalKg(geometry, pieces);

  // El material montado corta acá y no solo en el servidor: el API lo comprueba dentro de la
  // transacción del reporte, o sea después de una espera que la pantalla ya sabía perdida.
  if (coil !== undefined && newKg?.gt(toDecimal(coil.remainingKg)) === true) {
    return {
      ...base,
      pieces,
      newKg,
      error: `${coil.coilCode} tiene ${coil.remainingKg} kg montados y esto necesita ${newKg.toFixed(3)} kg: monta más material.`,
    };
  }

  const kg = draft.consumedKg.trim();
  if (kg !== '') {
    if (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0)) {
      return { ...base, pieces, newKg, error: 'Los kilos van con hasta tres decimales.' };
    }
  }

  // D-154: la desviación del kilo declarado **avisa**, con la misma función que el API usa
  // para dejarla anotada en el reporte. Dos redacciones serían dos umbrales distintos.
  const deviation =
    kg === '' || newKg === null
      ? null
      : roofingConsumptionDeviation({
          declaredKg: kg,
          theoreticalKg: newKg,
          alreadyDeclaredKg: order.declaredKg,
          planKg,
        });

  return { ...base, pieces, newKg, deviation };
}

/**
 * Los largos ya reportados de la orden, reconstruidos desde lo que el plan **todavía debe**:
 * es lo que `piecesFromPlanMeters` necesita para no volver a ofrecer una plancha que ya
 * salió. El DTO trae los pendientes ya resueltos por el servidor, así que la resta se hace
 * una sola vez y del lado que tiene los datos.
 *
 * Los pendientes se **acumulan** por largo y no se indexan directo: `remainingPlanPieces`
 * devuelve una entrada por ítem del plan, así que un plan con dos líneas del mismo largo
 * daba dos entradas y quedarse con la última contaba de menos lo ya reportado.
 */
function reportedOf(order: RoofingBatchOrderDto): RoofingPieceDto[] {
  const pending = order.remainingPieces.reduce<Map<string, number>>(
    (acc, p) => acc.set(p.lengthMm, (acc.get(p.lengthMm) ?? 0) + p.qty),
    new Map(),
  );
  return order.planItems.map((item, i) => {
    const left = pending.get(item.lengthMm) ?? 0;
    const used = Math.min(item.qty, left);
    pending.set(item.lengthMm, left - used);
    return { lineNumber: i + 1, lengthMm: item.lengthMm, qty: item.qty - used };
  });
}
