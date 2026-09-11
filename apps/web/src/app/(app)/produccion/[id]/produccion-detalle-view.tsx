'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  ProductionOrderKind,
  describePieces,
  piecesCount,
  piecesMeters,
  PRODUCTION_REPORT_STATUS_LABELS,
  Role,
  type ProductionOrderDto,
  type ProductionReportDto,
} from '@ayr/shared';
import { PRODUCTION_ORDER_TONE, PRODUCTION_REPORT_TONE } from '@/components/status-tone';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api, ApiError } from '@/lib/api';
import type { ReverseArgs } from '@/lib/reverse-args';
import {
  formatMoney,
  formatMoneyOrDash,
  formatQty,
  formatTimestampDate,
  unitSymbol,
} from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { useSession } from '@/lib/session';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Detalle de una orden de producción (RF-34/RF-35): los flejes que tomó, los reportes de
 * piezas con su kardex y —una vez cerrada— la merma de proceso y el costo por pieza.
 *
 * **D-160: acá no se produce.** Montar, reportar y cerrar viven en `/planta`, que es la única
 * entrada a producir; este detalle es de lectura, más las tres operaciones que **no** tienen
 * otro lugar y que no son captura sino corrección: anular la orden, revertir un reporte y
 * reabrir una cerrada. El cierre se fue de acá porque era el único que estaba en los dos
 * sitios, y dos botones que hacen lo mismo terminan divergiendo en lo que validan antes.
 */
export function ProduccionDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [reverting, setReverting] = useState<ProductionReportDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reopening, setReopening] = useState(false);

  const order = useQuery({
    queryKey: ['production-order', id],
    queryFn: () => api<ProductionOrderDto>(`/production/${id}`),
  });

  /**
   * D-087: las mutaciones de una orden de coberturas viven bajo `/production/roofing`.
   * El detalle es uno solo —una orden es una orden— pero cada verbo va a su rama, porque el
   * cuerpo y la aritmética no se parecen.
   */
  const base =
    order.data?.kind === ProductionOrderKind.ROOFING
      ? `/production/roofing/${id}`
      : `/production/${id}`;

  const invalidate = () => {
    invalidateProduction(queryClient, id);
  };

  const cancel = useMutation({
    mutationFn: ({ reason, operationDate }: ReverseArgs) =>
      api<ProductionOrderDto>(`${base}/cancel`, {
        method: 'POST',
        body: { reason, operationDate },
      }),
    onSuccess: () => {
      toast.success('Orden anulada: el material que tomó queda libre otra vez');
      setCancelling(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo anular la orden'),
  });

  const reopen = useMutation({
    mutationFn: ({ reason, operationDate }: ReverseArgs) =>
      api<ProductionOrderDto>(`${base}/reopen`, {
        method: 'POST',
        body: { reason, operationDate },
      }),
    onSuccess: () => {
      toast.success('Orden reabierta: la merma y el costeo del cierre quedaron revertidos');
      setReopening(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo reabrir la orden'),
  });

  const revert = useMutation({
    mutationFn: ({ reportId, reason, operationDate }: ReverseArgs & { reportId: string }) =>
      api<ProductionOrderDto>(`${base}/reports/${reportId}/reverse`, {
        method: 'POST',
        body: { reason, operationDate },
      }),
    onSuccess: () => {
      toast.success(
        'Reporte revertido: el producto sale del stock y los kilos vuelven al material',
      );
      setReverting(null);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo revertir el reporte'),
  });

  if (order.isPending) return <Skeleton className="h-64 w-full" />;
  if (order.isError || !order.data) {
    return <p className="text-destructive">No se pudo cargar la orden de producción.</p>;
  }

  const o = order.data;
  const isLive = o.status === 'DRAFT' || o.status === 'IN_PROGRESS';
  const activeReports = o.reports.filter((r) => r.status === 'ACTIVE');
  const lastActive = activeReports[activeReports.length - 1];
  const liveStrips = o.consumptions.filter((c) => c.releasedAt === null);
  const assignedKg = liveStrips.reduce(
    (acc, c) => acc.plus(new Decimal(c.assignedKg)),
    new Decimal(0),
  );
  // D-121: comparación reportado vs. teórico del fleje montado, solo drywall (coberturas
  // no tiene un kilo por pieza fijo: su propio card de "Despunte" ya compara declarado vs.
  // teórico). D-122/D-139: el dato es del SKU, no de la receta.
  const kgPerPiece =
    o.kind === ProductionOrderKind.ROOFING || o.productPieceWeightKg === null
      ? null
      : new Decimal(o.productPieceWeightKg);
  const theoreticalPieces = kgPerPiece?.gt(0) ? assignedKg.div(kgPerPiece) : null;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold">{o.code}</h1>
          <p className="text-xs text-muted-foreground">
            {o.productSku} · {o.productName} ·{' '}
            {o.kind === ProductionOrderKind.ROOFING
              ? `bobina de ${o.productThicknessMm ?? '—'} mm (±0.02)`
              : `${o.productPieceWeightKg ?? '—'} kg por pieza desde fleje de ${o.bom?.inputWidthMm ?? '—'} mm`}
            {o.salesOrderCode !== null && (
              <>
                {' '}
                ·{' '}
                <Link className={LINK_CLASSNAME} href={`/pedidos/${o.salesOrderId ?? ''}`}>
                  {o.salesOrderCode}
                </Link>{' '}
                · {o.customerName}
              </>
            )}
            {o.notes && <> · {o.notes}</>}
          </p>
          {o.items.length > 0 && (
            <p className="text-sm">
              Plan de corte: {describePieces(o.items)}{' '}
              <span className="text-muted-foreground">
                ({piecesCount(o.items)} planchas · {piecesMeters(o.items).toFixed(3)} m)
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
            {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
          </Badge>
          <Badge variant="outline">{PRODUCTION_ORDER_KIND_LABELS[o.kind]}</Badge>
          {/*
            D-160: **el detalle no produce.** Montar, reportar y cerrar viven en un solo
            lugar —`/planta`—, y este enlace lleva ahí con la orden ya enfocada. Tener el
            cierre también acá era el segundo camino vivo que la unificación vino a sacar:
            dos botones que hacen lo mismo terminan divergiendo en lo que validan antes.
          */}
          {isLive && (
            <Button asChild variant="outline">
              <Link
                href={
                  o.salesOrderId === null
                    ? `/planta?op=${o.id}`
                    : `/planta?pedido=${o.salesOrderId}&op=${o.id}`
                }
              >
                Producir esta orden
              </Link>
            </Button>
          )}
          {o.status === 'CLOSED' && (
            <Button
              variant="outline"
              onClick={() => {
                setReopening(true);
              }}
            >
              Reabrir orden
            </Button>
          )}
          {isLive && user.role === Role.ADMINISTRADOR && (
            <Button
              variant="destructive"
              onClick={() => {
                setCancelling(true);
              }}
            >
              Anular orden
            </Button>
          )}
        </div>
      </div>

      {/* Las columnas siguen a cuántas celdas hay de verdad: «Piezas teóricas» solo aparece
          en drywall, y con cinco columnas fijas la quinta quedaba como un bloque gris (la
          tira dibuja sus líneas con el color del borde por debajo). */}
      <StatStrip
        className={
          theoreticalPieces === null
            ? 'sm:grid-cols-2 lg:grid-cols-4'
            : 'sm:grid-cols-2 lg:grid-cols-5'
        }
      >
        <SummaryCard
          title={o.metersReported === null ? 'Piezas buenas' : 'Metros buenos'}
          value={o.metersReported === null ? String(o.piecesReported) : `${o.metersReported} m`}
          hint={o.metersReported === null ? undefined : `${String(o.piecesReported)} planchas`}
        />
        {theoreticalPieces !== null && (
          <SummaryCard
            title="Piezas teóricas"
            value={theoreticalPieces.toFixed(1)}
            hint={`Del fleje montado, vs. ${o.piecesReported} reportadas`}
          />
        )}
        <SummaryCard title="Material asignado" value={formatQty(o.assignedKg, 'kg')} />
        <SummaryCard
          title={o.kind === ProductionOrderKind.ROOFING ? 'Despunte' : 'Merma de proceso'}
          value={o.scrapKg ? formatQty(o.scrapKg, 'kg') : '—'}
          hint={
            o.kind === ProductionOrderKind.ROOFING
              ? `Al cerrar: los kilos declarados${o.consumedDeclaredKg ? ` (${formatQty(o.consumedDeclaredKg, 'kg')})` : ''} menos el teórico de las planchas reportadas`
              : 'Sale sola al cerrar: kilos asignados menos el teórico de las piezas buenas'
          }
        />
        <SummaryCard
          title={
            o.kind === ProductionOrderKind.ROOFING
              ? `Costo por ${unitSymbol(o.productUnit)}`
              : 'Costo por pieza'
          }
          value={formatMoneyOrDash(o.unitCostPen, 'PEN', 4)}
          hint={
            o.totalCostPen
              ? `Material ${formatMoney(o.materialCostPen ?? '0', 'PEN', 2)} · sin mano de obra ni overhead en v1`
              : 'Se calcula al cerrar la orden'
          }
        />
      </StatStrip>

      <Card>
        <CardHeader>
          <CardTitle>
            {o.kind === ProductionOrderKind.ROOFING
              ? 'Bobinas montadas en la orden'
              : 'Flejes consumidos por la orden'}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{o.kind === ProductionOrderKind.ROOFING ? 'Bobina' : 'Fleje'}</TableHead>
                <TableHead>Bobina madre</TableHead>
                <TableHead className="text-right">Asignado</TableHead>
                <TableHead className="text-right">Consumido</TableHead>
                <TableHead className="text-right">Pendiente</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.consumptions.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link className={cn('font-mono', LINK_CLASSNAME)} href={`/bobinas/${c.coilId}`}>
                      {c.coilCode}
                    </Link>
                    <div className="text-xs text-muted-foreground">{c.widthMm} mm</div>
                  </TableCell>
                  <TableCell>
                    {c.parentCoilId ? (
                      <Link
                        className={cn('font-mono text-sm', LINK_CLASSNAME)}
                        href={`/bobinas/${c.parentCoilId}`}
                      >
                        {c.parentCoilCode}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatQty(c.assignedKg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatQty(c.consumedKg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatQty(c.remainingKg, 'kg')}</TableCell>
                  <TableCell>
                    <Badge variant={c.releasedAt ? 'outline' : 'secondary'}>
                      {c.releasedAt ? 'Liberado' : 'Tomado por la orden'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {o.consumptions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    La orden todavía no tomó ningún fleje.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reportes de piezas</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Piezas</TableHead>
                <TableHead className="text-right">Fleje teórico</TableHead>
                <TableHead className="text-right">Material</TableHead>
                <TableHead className="text-right">Costo/pieza</TableHead>
                <TableHead>Operario</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatTimestampDate(r.createdAt)}</TableCell>
                  <TableCell className="text-right font-medium">{r.pieces}</TableCell>
                  <TableCell className="text-right">{formatQty(r.theoreticalKg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.materialCostPen)}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(r.unitCostPen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.createdByName ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={PRODUCTION_REPORT_TONE[r.status]}>
                      {PRODUCTION_REPORT_STATUS_LABELS[r.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {o.status === 'IN_PROGRESS' && r.id === lastActive?.id && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setReverting(r);
                        }}
                      >
                        Revertir
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {o.reports.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Todavía no se reportaron piezas.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ReasonDialog
        open={reverting !== null}
        onOpenChange={(open) => {
          if (!open) setReverting(null);
        }}
        title="Revertir el reporte de piezas"
        description={
          reverting
            ? `Las ${reverting.pieces} piezas salen del stock del producto y los ${reverting.theoreticalKg} kg vuelven a los flejes de la orden. Solo se puede si esas piezas todavía no se movieron.`
            : ''
        }
        confirmLabel="Sí, revertir"
        pending={revert.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          if (reverting) revert.mutate({ reportId: reverting.id, reason, operationDate });
        }}
      />

      <ReasonDialog
        open={reopening}
        onOpenChange={setReopening}
        title="Reabrir la orden de producción"
        description="Se revierten la merma de proceso y el ajuste de costo del cierre; los flejes vuelven a quedar tomados por la orden. Solo se puede si las piezas y los flejes no se movieron después de cerrarla."
        confirmLabel="Sí, reabrir"
        pending={reopen.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          reopen.mutate({ reason, operationDate });
        }}
      />

      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Anular la orden de producción"
        description={`Los ${liveStrips.length} fleje(s) que la orden tiene tomados quedan libres otra vez. Solo se puede si no le queda ningún reporte de piezas vigente.`}
        confirmLabel="Sí, anular"
        pending={cancel.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          cancel.mutate({ reason, operationDate });
        }}
      />
    </RoleGate>
  );
}

/**
 * S11/D-179: la misma tira que el resto de los detalles, con su renglón de contexto.
 *
 * La cifra va en su propio elemento y no suelta junto al renglón: pegadas, el nodo de texto
 * pasa a ser «1200.0Del fleje montado, vs. 0 reportadas» y deja de existir un elemento cuyo
 * texto sea la cifra. Lo detectó `fase7e-ajustes-d121.spec.ts:92`, que busca el valor con
 * `exact: true` — y tiene razón en buscarlo así: lo que la pantalla promete es mostrar la
 * cifra, no una cadena que la contenga.
 */
function SummaryCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Stat label={title}>
      <div>{value}</div>
      {hint && <div className="mt-0.5 text-xs font-normal text-muted-foreground">{hint}</div>}
    </Stat>
  );
}
