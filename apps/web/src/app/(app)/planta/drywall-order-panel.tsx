'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  PRODUCTION_ORDER_STATUS_LABELS,
  type ProductionOrderDto,
  type ProductionStripOptionDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import type { ReverseArgs } from '@/lib/reverse-args';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { LINK_CLASSNAME } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * La captura de una corrida de **perfiles de drywall** dentro del espacio de producción
 * (RF-39, D-087).
 *
 * Salió de `planta-view.tsx` con D-160, cuando la terminal y el espacio de producción se
 * fundieron en una sola pantalla: el panel es ahora una de las dos formas que puede tomar la
 * orden seleccionada —la otra es `RoofingOrderPanel`—, y la bifurcación la decide la clase de
 * la orden, no la ruta.
 *
 * Lo que se captura es piezas y no largos: un perfil sale de un fleje con un peso por pieza
 * fijo del SKU (D-122/D-139), y esa aritmética no se parece en nada a la de coberturas.
 */
export function DrywallOrderPanel({
  orderId,
  asList,
}: {
  orderId: string;
  /**
   * El picker dejó de ser pestañas por encima de `MAX_ORDER_TABS`, y el panel tiene que
   * dejar de ser `tabpanel` con él: un botón con `role="tab"` que apunta por `aria-controls`
   * a algo que no es un `tabpanel` le miente al lector de pantalla en las dos direcciones.
   */
  asList: boolean;
}) {
  const queryClient = useQueryClient();
  const [pieces, setPieces] = useState('');
  const [closing, setClosing] = useState(false);
  // D-124: día de negocio del reporte de piezas y del cierre. Planta no lo ve —el campo es
  // solo para ADMINISTRADOR—; existe para que la carga histórica pueda fechar la corrida.
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);

  const order = useQuery({
    queryKey: ['production-order', orderId],
    queryFn: () => api<ProductionOrderDto>(`/production/${orderId}`),
  });
  const productId = order.data?.productId ?? '';
  const strips = useQuery({
    queryKey: ['production-strips', productId],
    queryFn: () => api<ProductionStripOptionDto[]>(`/production/strips?productId=${productId}`),
    enabled:
      productId !== '' && order.data?.status !== 'CLOSED' && order.data?.status !== 'CANCELLED',
  });

  const invalidate = () => {
    invalidateProduction(queryClient, orderId);
  };

  const consume = useMutation({
    mutationFn: (coilId: string) =>
      api<ProductionOrderDto>(`/production/${orderId}/consume`, {
        method: 'POST',
        body: { coilId },
      }),
    onSuccess: () => {
      toast.success('Fleje montado en la orden');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo consumir el fleje'),
  });

  const release = useMutation({
    mutationFn: (consumptionId: string) =>
      api<ProductionOrderDto>(`/production/${orderId}/consumptions/${consumptionId}/release`, {
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
    mutationFn: ({ count, confirmBackdate }: { count: number; confirmBackdate: boolean }) =>
      api<ProductionOrderDto>(`/production/${orderId}/report`, {
        method: 'POST',
        body: { pieces: count, operationDate, confirmBackdate: confirmBackdate || undefined },
      }),
    onSuccess: (o) => {
      toast.success(`Reportadas las piezas: ${o.piecesReported} en total`);
      setPieces('');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudieron reportar las piezas'),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await report.mutateAsync({ count: Number(pieces.trim()), confirmBackdate });
  });

  const close = useMutation({
    mutationFn: ({ reason, operationDate: date }: Partial<ReverseArgs>) =>
      api<ProductionOrderDto>(`/production/${orderId}/close`, {
        method: 'POST',
        body: { reason: reason ?? undefined, operationDate: date },
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
    return <p className="text-destructive">No se pudo cargar la orden.</p>;
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
  // D-122/D-139: los kilos que consume cada pieza son del SKU, no de la receta.
  const kgPerPiece = new Decimal(o.productPieceWeightKg ?? '0');
  const maxPieces = kgPerPiece.lte(0) ? 0 : pendingKg.div(kgPerPiece).floor().toNumber();
  // D-121: piezas teóricas de TODO lo montado en la orden (no solo lo pendiente), para
  // comparar en vivo contra lo ya reportado — el mismo cálculo que hace el cierre para la
  // merma de proceso, pero antes de cerrar y sin redondear.
  const theoreticalPieces = kgPerPiece.gt(0) ? assignedKg.div(kgPerPiece) : new Decimal(0);
  const theoreticalDelta = theoreticalPieces.minus(o.piecesReported);
  const trimmed = pieces.trim();
  const piecesValid = /^\d+$/.test(trimmed) && Number(trimmed) > 0;
  const overCapacity = piecesValid && Number(trimmed) > maxPieces;
  const isLive = o.status === 'DRAFT' || o.status === 'IN_PROGRESS';

  return (
    <section
      role={asList ? undefined : 'tabpanel'}
      id={`panel-${orderId}`}
      aria-labelledby={`tab-${orderId}`}
      className="grid gap-4"
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono">{o.code}</span>
            <Badge variant={o.status === 'IN_PROGRESS' ? 'default' : 'secondary'}>
              {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
            </Badge>
            <Badge variant="outline">Perfiles</Badge>
            <span className="font-normal text-muted-foreground">
              {o.productSku} · {o.productName}
              {o.salesOrderCode !== null && o.salesOrderId !== null && (
                <>
                  {' · '}
                  <Link href={`/pedidos/${o.salesOrderId}`} className={LINK_CLASSNAME}>
                    {o.salesOrderCode}
                  </Link>
                </>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-5">
            <BigStat label="Piezas buenas" value={String(o.piecesReported)} />
            <BigStat
              label="Piezas teóricas"
              value={theoreticalPieces.toFixed(1)}
              hint={
                assignedKg.gt(0)
                  ? `Fleje montado: ${theoreticalDelta.gte(0) ? '+' : ''}${theoreticalDelta.toFixed(1)} vs. reportado`
                  : undefined
              }
            />
            <BigStat label="Meta" value={o.targetPieces === null ? '—' : String(o.targetPieces)} />
            <BigStat label="Fleje pendiente" value={formatQty(pendingKg.toFixed(3), 'kg')} />
            <BigStat label="Alcanza para" value={`${String(maxPieces)} pzs`} />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/produccion/${o.id}`} className="underline">
              Ver el detalle de la orden
            </Link>
          </p>
        </CardContent>
      </Card>

      {isLive && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Reportar piezas</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor={`piezas-${orderId}`}>Piezas buenas de esta tanda</Label>
              <Input
                id={`piezas-${orderId}`}
                aria-label={`Piezas buenas de ${o.code}`}
                inputMode="numeric"
                className="h-16 text-3xl"
                value={pieces}
                onChange={(e) => {
                  setPieces(e.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Button
                className="h-16 text-lg"
                disabled={!piecesValid || overCapacity || report.isPending}
                onClick={() => {
                  void backdate.attempt();
                }}
              >
                {report.isPending ? 'Registrando…' : `Guardar ${o.code}`}
              </Button>
              <OperationDateField value={operationDate} onChange={setOperationDate} />
            </div>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Cada pieza consume {o.productPieceWeightKg ?? '—'} kg de fleje según el catálogo.
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
        <CardHeader className="pb-3">
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
          <CardHeader className="pb-3">
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
                No hay flejes libres que coincidan con la receta
                {o.bom && (
                  <>
                    {' '}
                    ({o.bom.finishCode}, {o.bom.inputThicknessMm} mm de espesor,{' '}
                    {o.bom.inputWidthMm} mm de ancho)
                  </>
                )}
                .
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
            else close.mutate({ reason: undefined, operationDate: undefined });
          }}
        >
          {close.isPending
            ? 'Cerrando…'
            : `Cerrar ${o.code} (${formatQty(pendingKg.toFixed(3), 'kg')} irán a merma)`}
        </Button>
      )}

      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title="Cerrar con merma de proceso"
        description={`Quedan ${formatQty(pendingKg.toFixed(3), 'kg')} sin convertir en piezas sobre ${formatQty(assignedKg.toFixed(3), 'kg')} montados: esa diferencia sale del inventario como merma y su costo se reparte entre las piezas buenas. Explica por qué.`}
        confirmLabel="Cerrar la orden"
        pending={close.isPending}
        withOperationDate
        onConfirm={(reason, date) => {
          close.mutate({ reason, operationDate: date });
        }}
      />

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

function BigStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
