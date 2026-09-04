'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MAX_ORDER_STRIPS,
  MAX_REPORT_PIECES,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  PRODUCTION_ORDER_STATUS_LABELS,
  Role,
  type ProductBomDto,
  type ProductionOrderDto,
  type ReservationDto,
  type ProductionOrderListItemDto,
  type ProductionStripOptionDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { invalidateProduction } from '@/lib/production-queries';

/**
 * Terminal de planta (RF-39, D-013: no hay app nativa, es una ruta web responsive).
 * Mobile-first a propósito: el operario la usa de pie, con guantes y en una tablet, así
 * que todo son tarjetas de una columna y botones altos; el escritorio solo ensancha la
 * grilla. Lo que no es captura —costos, kardex, correcciones— vive en `/produccion`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PlantaView() {
  const searchParams = useSearchParams();
  // `?op=` es lo que usa el enlace "Abrir en planta" del detalle. Se valida antes de
  // meterlo en una URL del API, y se re-lee cuando cambia: sin el efecto, navegar de
  // `?op=A` a `?op=B` sin desmontar la ruta dejaba la terminal en la orden anterior.
  const fromUrl = searchParams.get('op');
  const [selectedId, setSelectedId] = useState<string | null>(
    fromUrl && UUID.test(fromUrl) ? fromUrl : null,
  );
  useEffect(() => {
    if (fromUrl && UUID.test(fromUrl)) setSelectedId(fromUrl);
  }, [fromUrl]);

  // Volver al selector limpia también el `?op=`, o un refresh reabriría la orden que el
  // operario acababa de dejar.
  const router = useRouter();
  const onBack = () => {
    setSelectedId(null);
    if (fromUrl) router.replace('/planta');
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      {selectedId ? (
        <OrderTerminal id={selectedId} onBack={onBack} />
      ) : (
        <OrderPicker onSelect={setSelectedId} />
      )}
    </RoleGate>
  );
}

// ---------------------------------------------------------------------------
// Pantalla 1 — elegir o abrir una orden
// ---------------------------------------------------------------------------

function OrderPicker({ onSelect }: { onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [targetPieces, setTargetPieces] = useState('');
  /** D-066: pedido contra el que se fabrica. Vacío = corrida de stock, sin reserva detrás. */
  const [reservationId, setReservationId] = useState('');

  const boms = useQuery({
    queryKey: ['production-boms'],
    queryFn: () => api<ProductBomDto[]>('/production/boms'),
  });
  // Solo las órdenes vivas, y filtradas por el API: traer las 500 más recientes para
  // quedarse con tres es caro en una tablet, y con el historial acumulado una orden
  // abierta vieja se caía del listado sin ningún aviso.
  const draft = useQuery({
    queryKey: ['production-orders', 'planta', 'DRAFT'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=DRAFT'),
  });
  const inProgress = useQuery({
    queryKey: ['production-orders', 'planta', 'IN_PROGRESS'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=IN_PROGRESS'),
  });
  /**
   * Reservas activas: los pedidos que esperan que planta fabrique (D-066).
   *
   * Sin esto la reserva no tenía consumidor en la UI y el guardrail se volvía en contra: al
   * confirmar un pedido, el material quedaba bloqueado para **toda** orden que no fuera la
   * nacida de esa reserva, y planta no tenía forma de crear esa orden. El fleje prometido se
   * volvía inmovilizable hasta que un administrador liberara la reserva a mano — lo contrario
   * de para qué se reserva.
   */
  const reservations = useQuery({
    queryKey: ['reservations', 'ACTIVE'],
    queryFn: () => api<ReservationDto[]>('/sales/reservations?status=ACTIVE'),
  });

  const create = useMutation({
    mutationFn: () =>
      api<ProductionOrderDto>('/production', {
        method: 'POST',
        body: {
          productId,
          ...(targetPieces.trim() ? { targetPieces: Number(targetPieces.trim()) } : {}),
          ...(reservationId ? { reservationId } : {}),
        },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada`);
      setProductId('');
      setTargetPieces('');
      setReservationId('');
      invalidateProduction(queryClient);
      onSelect(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  const activeBoms = (boms.data ?? []).filter((b) => b.isActive);
  // Solo las reservas de pedidos que piden **este** perfil: el API rechaza cualquier otra
  // (una reserva solo autoriza a fabricar lo que su propio pedido encargó).
  const productReservations = (reservations.data ?? []).filter((r) =>
    r.orderProductIds.includes(productId),
  );
  const liveOrders = [...(inProgress.data ?? []), ...(draft.data ?? [])];
  const ordersPending = draft.isPending || inProgress.isPending;
  const ordersError = draft.isError || inProgress.isError;
  const piecesValue = targetPieces.trim();
  // Las mismas cotas que el API (`piecesSchema`): 1 .. MAX_REPORT_PIECES enteras.
  const piecesInvalid =
    piecesValue !== '' &&
    (!/^\d+$/.test(piecesValue) ||
      Number(piecesValue) < 1 ||
      Number(piecesValue) > MAX_REPORT_PIECES);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Planta</h1>
        <p className="text-sm text-muted-foreground">
          Captura de la corrida de perfiles: consumir fleje, reportar piezas y cerrar (RF-39).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nueva orden</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="planta-producto">Perfil a fabricar</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger id="planta-producto" className="h-12">
                <SelectValue placeholder="Elige el perfil" />
              </SelectTrigger>
              <SelectContent>
                {activeBoms.map((b) => (
                  <SelectItem key={b.productId} value={b.productId}>
                    {b.productSku} — {b.productName} ({b.inputWidthMm} mm)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="planta-meta">Meta de piezas (opcional)</Label>
            <Input
              id="planta-meta"
              inputMode="numeric"
              className="h-12 text-lg"
              value={targetPieces}
              onChange={(e) => {
                setTargetPieces(e.target.value);
              }}
            />
          </div>
          <Button
            className="h-12"
            disabled={!productId || piecesInvalid || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Creando…' : 'Crear orden'}
          </Button>
          {productId !== '' && productReservations.length > 0 && (
            <div className="grid gap-2 sm:col-span-3">
              <Label htmlFor="planta-pedido">Pedido a atender (opcional)</Label>
              <Select value={reservationId} onValueChange={setReservationId}>
                <SelectTrigger id="planta-pedido" className="h-12">
                  <SelectValue placeholder="Corrida de stock, sin pedido" />
                </SelectTrigger>
                <SelectContent>
                  {productReservations.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.salesOrderCode} — {r.customerName} — {r.itemLabel} ({r.qty} {r.unit})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                Con un pedido elegido, la orden puede montar el material que ese pedido reservó —
                que para cualquier otra orden está bloqueado.
              </p>
            </div>
          )}
          {boms.isPending && <Skeleton className="h-5 w-full sm:col-span-3" />}
          {boms.isError && (
            <p className="text-sm text-destructive sm:col-span-3">
              No se pudieron cargar las recetas de fabricación.
            </p>
          )}
          {boms.isSuccess && activeBoms.length === 0 && (
            <p className="text-sm text-muted-foreground sm:col-span-3">
              Ningún perfil tiene receta cargada todavía: pídesela a un administrador desde el
              catálogo.
            </p>
          )}
          {piecesInvalid && (
            <p className="text-sm text-destructive sm:col-span-3">
              La meta de piezas es un número entero entre 1 y {MAX_REPORT_PIECES}.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3">
        <h2 className="text-lg font-medium">Órdenes en curso</h2>
        {ordersPending && <Skeleton className="h-24 w-full" />}
        {ordersError && (
          <p className="text-sm text-destructive">No se pudieron cargar las órdenes.</p>
        )}
        {!ordersPending && !ordersError && liveOrders.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hay ninguna orden abierta. Crea una arriba para empezar.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {liveOrders.map((o) => (
            <button
              key={o.id}
              type="button"
              className="rounded-lg border p-4 text-left transition hover:bg-accent"
              onClick={() => {
                onSelect(o.id);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-lg font-semibold">{o.code}</span>
                <Badge variant={o.status === 'IN_PROGRESS' ? 'default' : 'outline'}>
                  {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                </Badge>
              </div>
              <div className="mt-1 text-sm">{o.productSku}</div>
              <div className="text-xs text-muted-foreground">{o.productName}</div>
              <div className="mt-3 text-sm">
                {o.piecesReported} piezas
                {o.targetPieces !== null && <> de {o.targetPieces}</>} ·{' '}
                {formatQty(o.assignedKg, 'kg')} de fleje
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pantalla 2 — operar una orden
// ---------------------------------------------------------------------------

function OrderTerminal({ id, onBack }: { id: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [pieces, setPieces] = useState('');
  const [closing, setClosing] = useState(false);

  const order = useQuery({
    queryKey: ['production-order', id],
    queryFn: () => api<ProductionOrderDto>(`/production/${id}`),
  });
  const productId = order.data?.productId ?? '';
  const strips = useQuery({
    queryKey: ['production-strips', productId],
    queryFn: () => api<ProductionStripOptionDto[]>(`/production/strips?productId=${productId}`),
    enabled:
      productId !== '' && order.data?.status !== 'CLOSED' && order.data?.status !== 'CANCELLED',
  });

  const invalidate = () => {
    invalidateProduction(queryClient, id);
  };

  const consume = useMutation({
    mutationFn: (coilId: string) =>
      api<ProductionOrderDto>(`/production/${id}/consume`, { method: 'POST', body: { coilId } }),
    onSuccess: () => {
      toast.success('Fleje montado en la orden');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo consumir el fleje'),
  });

  const release = useMutation({
    mutationFn: (consumptionId: string) =>
      api<ProductionOrderDto>(`/production/${id}/consumptions/${consumptionId}/release`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Fleje liberado de la orden');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo liberar el fleje'),
  });

  const report = useMutation({
    mutationFn: (count: number) =>
      api<ProductionOrderDto>(`/production/${id}/report`, {
        method: 'POST',
        body: { pieces: count },
      }),
    onSuccess: (o) => {
      toast.success(`Reportadas las piezas: ${o.piecesReported} en total`);
      setPieces('');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudieron reportar las piezas'),
  });

  const close = useMutation({
    mutationFn: (reason?: string) =>
      api<ProductionOrderDto>(`/production/${id}/close`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    onSuccess: (o) => {
      toast.success(
        `Orden cerrada: ${o.piecesReported} piezas y ${formatQty(o.scrapKg ?? '0.000', 'kg')} de merma`,
      );
      setClosing(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cerrar la orden'),
  });

  if (order.isPending) return <Skeleton className="h-64 w-full" />;
  if (order.isError || !order.data) {
    return (
      <div className="grid gap-3">
        <p className="text-destructive">No se pudo cargar la orden.</p>
        <Button variant="outline" onClick={onBack}>
          Volver
        </Button>
      </div>
    );
  }

  const o = order.data;
  const liveStrips = o.consumptions.filter((c) => c.releasedAt === null);
  const pendingKg = liveStrips.reduce(
    (acc, c) => acc.plus(new Decimal(c.remainingKg)),
    new Decimal(0),
  );
  const assignedKg = liveStrips.reduce(
    (acc, c) => acc.plus(new Decimal(c.assignedKg)),
    new Decimal(0),
  );
  const needsReason =
    assignedKg.gt(0) && pendingKg.div(assignedKg).gt(MAX_SCRAP_RATIO_WITHOUT_REASON);
  const kgPerPiece = new Decimal(o.bom.kgPerPiece);
  const maxPieces = kgPerPiece.lte(0) ? 0 : pendingKg.div(kgPerPiece).floor().toNumber();
  const trimmed = pieces.trim();
  const piecesValid = /^\d+$/.test(trimmed) && Number(trimmed) > 0;
  const overCapacity = piecesValid && Number(trimmed) > maxPieces;
  const isLive = o.status === 'DRAFT' || o.status === 'IN_PROGRESS';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{o.code}</h1>
            <Badge variant={o.status === 'IN_PROGRESS' ? 'default' : 'secondary'}>
              {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {o.productSku} · {o.productName}
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
        <BigStat label="Piezas buenas" value={String(o.piecesReported)} />
        <BigStat label="Meta" value={o.targetPieces === null ? '—' : String(o.targetPieces)} />
        <BigStat label="Fleje pendiente" value={formatQty(pendingKg.toFixed(3), 'kg')} />
        <BigStat label="Alcanza para" value={`${maxPieces} pzs`} />
      </div>

      {isLive && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reportar piezas</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="planta-piezas">Piezas buenas de esta tanda</Label>
              <Input
                id="planta-piezas"
                inputMode="numeric"
                className="h-16 text-3xl"
                value={pieces}
                onChange={(e) => {
                  setPieces(e.target.value);
                }}
              />
            </div>
            <Button
              className="h-16 text-lg"
              disabled={!piecesValid || overCapacity || report.isPending}
              onClick={() => {
                report.mutate(Number(trimmed));
              }}
            >
              {report.isPending ? 'Registrando…' : 'Reportar'}
            </Button>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Cada pieza consume {o.bom.kgPerPiece} kg de fleje según la receta.
              {overCapacity && (
                <span className="text-destructive">
                  {' '}
                  Con el fleje montado solo alcanza para {maxPieces} piezas: consume otro fleje
                  antes de reportar.
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flejes montados</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {liveStrips.length === 0 && (
            <p className="text-sm text-muted-foreground">
              La orden no tiene ningún fleje montado todavía.
            </p>
          )}
          {liveStrips.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <div className="font-mono font-medium">{c.coilCode}</div>
                <div className="text-sm text-muted-foreground">
                  {c.widthMm} mm · pendiente {formatQty(c.remainingKg, 'kg')} de{' '}
                  {formatQty(c.assignedKg, 'kg')}
                  {c.parentCoilCode && <> · madre {c.parentCoilCode}</>}
                </div>
              </div>
              {isLive && new Decimal(c.consumedKg).lte(0) && (
                <Button
                  variant="outline"
                  className="h-12"
                  aria-label={`Liberar el fleje ${c.coilCode}`}
                  disabled={release.isPending}
                  onClick={() => {
                    release.mutate(c.id);
                  }}
                >
                  Liberar
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {isLive && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consumir otro fleje</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {strips.isPending && <Skeleton className="h-16 w-full" />}
            {strips.isError && (
              <p className="text-sm text-destructive">
                No se pudieron cargar los flejes disponibles.
              </p>
            )}
            {strips.isSuccess && strips.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hay flejes libres que coincidan con la receta ({o.bom.finishCode},{' '}
                {o.bom.inputThicknessMm} mm de espesor, {o.bom.inputWidthMm} mm de ancho).
              </p>
            )}
            {liveStrips.length >= MAX_ORDER_STRIPS && (
              <p className="text-sm text-destructive">
                La orden ya tiene los {MAX_ORDER_STRIPS} flejes que admite a la vez: ciérrala y abre
                otra.
              </p>
            )}
            {strips.data?.map((s) => (
              <div
                key={s.coilId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <div className="font-mono font-medium">{s.code}</div>
                  <div className="text-sm text-muted-foreground">
                    {formatQty(s.availableKg, 'kg')} · alcanza para {s.estimatedPieces} piezas
                    {s.parentCoilCode && <> · madre {s.parentCoilCode}</>}
                  </div>
                </div>
                <Button
                  className="h-12"
                  aria-label={`Montar el fleje ${s.code}`}
                  disabled={consume.isPending || liveStrips.length >= MAX_ORDER_STRIPS}
                  onClick={() => {
                    consume.mutate(s.coilId);
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
        <Button
          className="h-16 text-lg"
          disabled={close.isPending}
          onClick={() => {
            // Con mucha merma, cerrar es una baja de inventario y el API pide motivo
            // (D-057): se lo pedimos acá en vez de gastar un 400.
            if (needsReason) setClosing(true);
            else close.mutate(undefined);
          }}
        >
          {close.isPending
            ? 'Cerrando…'
            : `Cerrar orden (${formatQty(pendingKg.toFixed(3), 'kg')} irán a merma)`}
        </Button>
      )}

      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title="Cerrar con merma de proceso"
        description={`Quedan ${formatQty(pendingKg.toFixed(3), 'kg')} sin convertir en piezas sobre ${formatQty(assignedKg.toFixed(3), 'kg')} montados: esa diferencia sale del inventario como merma y su costo se reparte entre las piezas buenas. Explica por qué.`}
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
