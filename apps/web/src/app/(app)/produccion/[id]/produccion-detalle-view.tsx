'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_REPORT_STATUS_LABELS,
  Role,
  type ProductionOrderDto,
  type ProductionReportDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatMoneyOrDash, formatQty } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { useSession } from '@/lib/session';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
 * Detalle de una orden de producción (RF-34/RF-35): los flejes que tomó, los reportes de
 * piezas con su kardex y —una vez cerrada— la merma de proceso y el costo por pieza.
 * Las acciones de planta (consumir, reportar) viven en `/planta`; acá están las de
 * corrección y cierre.
 */
export function ProduccionDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [reverting, setReverting] = useState<ProductionReportDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [closing, setClosing] = useState(false);

  const order = useQuery({
    queryKey: ['production-order', id],
    queryFn: () => api<ProductionOrderDto>(`/production/${id}`),
  });

  const invalidate = () => {
    invalidateProduction(queryClient, id);
  };

  const close = useMutation({
    mutationFn: (reason?: string) =>
      api<ProductionOrderDto>(`/production/${id}/close`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    onSuccess: (o) => {
      toast.success(
        `Orden cerrada: ${o.piecesReported} piezas, ${formatQty(o.scrapKg ?? '0.000', 'kg')} de merma de proceso`,
      );
      setClosing(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cerrar la orden'),
  });

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<ProductionOrderDto>(`/production/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Orden anulada: los flejes que tomó quedan libres otra vez');
      setCancelling(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo anular la orden'),
  });

  const reopen = useMutation({
    mutationFn: (reason: string) =>
      api<ProductionOrderDto>(`/production/${id}/reopen`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Orden reabierta: la merma y el costeo del cierre quedaron revertidos');
      setReopening(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo reabrir la orden'),
  });

  const revert = useMutation({
    mutationFn: ({ reportId, reason }: { reportId: string; reason: string }) =>
      api<ProductionOrderDto>(`/production/${id}/reports/${reportId}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Reporte revertido: las piezas salen del stock y los kilos vuelven al fleje');
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
  const pendingKg = liveStrips.reduce(
    (acc, c) => acc.plus(new Decimal(c.remainingKg)),
    new Decimal(0),
  );
  const assignedKg = liveStrips.reduce(
    (acc, c) => acc.plus(new Decimal(c.assignedKg)),
    new Decimal(0),
  );
  // Con mucha merma, cerrar es una baja de inventario y el API pide motivo (D-057).
  const closeNeedsReason =
    assignedKg.gt(0) && pendingKg.div(assignedKg).gt(MAX_SCRAP_RATIO_WITHOUT_REASON);

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold">{o.code}</h1>
          <p className="text-sm text-muted-foreground">
            {o.productSku} · {o.productName} · receta {o.bom.kgPerPiece} kg por pieza desde fleje de{' '}
            {o.bom.inputWidthMm} mm
            {o.notes && <> · {o.notes}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={o.status === 'IN_PROGRESS' ? 'default' : 'secondary'}>
            {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
          </Badge>
          {isLive && (
            <Button asChild variant="outline">
              <Link href={`/planta?op=${o.id}`}>Abrir en planta</Link>
            </Button>
          )}
          {o.status === 'IN_PROGRESS' && activeReports.length > 0 && (
            <Button
              disabled={close.isPending}
              onClick={() => {
                if (closeNeedsReason) setClosing(true);
                else close.mutate(undefined);
              }}
            >
              {close.isPending ? 'Cerrando…' : 'Cerrar orden'}
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Piezas buenas" value={String(o.piecesReported)} />
        <SummaryCard title="Fleje asignado" value={formatQty(o.assignedKg, 'kg')} />
        <SummaryCard
          title="Merma de proceso"
          value={o.scrapKg ? formatQty(o.scrapKg, 'kg') : '—'}
          hint="Sale sola al cerrar: kilos asignados menos el teórico de las piezas buenas"
        />
        <SummaryCard
          title="Costo por pieza"
          value={formatMoneyOrDash(o.unitCostPen, 'PEN', 4)}
          hint={
            o.totalCostPen
              ? `Material ${formatMoney(o.materialCostPen ?? '0', 'PEN', 2)} · sin mano de obra ni overhead en v1`
              : 'Se calcula al cerrar la orden'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flejes consumidos por la orden</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fleje</TableHead>
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
                    <Link
                      className="font-mono underline underline-offset-4"
                      href={`/bobinas/${c.coilId}`}
                    >
                      {c.coilCode}
                    </Link>
                    <div className="text-xs text-muted-foreground">{c.widthMm} mm</div>
                  </TableCell>
                  <TableCell>
                    {c.parentCoilId ? (
                      <Link
                        className="font-mono text-sm underline underline-offset-4"
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
          <CardTitle className="text-base">Reportes de piezas</CardTitle>
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
                  <TableCell>{formatDate(r.createdAt.slice(0, 10))}</TableCell>
                  <TableCell className="text-right font-medium">{r.pieces}</TableCell>
                  <TableCell className="text-right">{formatQty(r.theoreticalKg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.materialCostPen)}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(r.unitCostPen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.createdByName ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === 'ACTIVE' ? 'secondary' : 'outline'}>
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
        onConfirm={(reason) => {
          if (reverting) revert.mutate({ reportId: reverting.id, reason });
        }}
      />

      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title="Cerrar con merma de proceso"
        description={`Quedan ${formatQty(pendingKg.toFixed(3), 'kg')} sin convertir en piezas sobre ${formatQty(assignedKg.toFixed(3), 'kg')} asignados: esa diferencia sale del inventario como merma y su costo se reparte entre las piezas buenas. Explica por qué.`}
        confirmLabel="Cerrar la orden"
        pending={close.isPending}
        onConfirm={(reason) => {
          close.mutate(reason);
        }}
      />

      <ReasonDialog
        open={reopening}
        onOpenChange={setReopening}
        title="Reabrir la orden de producción"
        description="Se revierten la merma de proceso y el ajuste de costo del cierre; los flejes vuelven a quedar tomados por la orden. Solo se puede si las piezas y los flejes no se movieron después de cerrarla."
        confirmLabel="Sí, reabrir"
        pending={reopen.isPending}
        onConfirm={(reason) => {
          reopen.mutate(reason);
        }}
      />

      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Anular la orden de producción"
        description={`Los ${liveStrips.length} fleje(s) que la orden tiene tomados quedan libres otra vez. Solo se puede si no le queda ningún reporte de piezas vigente.`}
        confirmLabel="Sí, anular"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          cancel.mutate(reason);
        }}
      />
    </RoleGate>
  );
}

function SummaryCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
