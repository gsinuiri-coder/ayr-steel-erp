'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  CUTTING_ORDER_COIL_STATUS_LABELS,
  CUTTING_ORDER_STATUS_LABELS,
  Role,
  type CuttingOrderCoilDto,
  type CuttingOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatQty } from '@/lib/format';
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
import { CuttingReceiveDialog } from './cutting-receive-dialog';

/**
 * Detalle de una orden de corte (RF-40..42, RF-22): sus bobinas, el plan de anchos
 * frente a lo realmente recibido, los servicios de corte ya imputados y las acciones
 * por rol (§3.4): SUPERVISOR_PLANTA recibe y cancela lo pendiente; vincular la factura
 * del servicio es el flujo normal de compras.
 */
export function CorteDetalleView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [receiving, setReceiving] = useState<CuttingOrderCoilDto | null>(null);
  const [reverting, setReverting] = useState<CuttingOrderCoilDto | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const order = useQuery({
    queryKey: ['cutting-order', id],
    queryFn: () => api<CuttingOrderDto>(`/cutting/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cutting-order', id] });
    void queryClient.invalidateQueries({ queryKey: ['cutting-orders'] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
    void queryClient.invalidateQueries({ queryKey: ['cutting', 'strips'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<CuttingOrderDto>(`/cutting/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Lo pendiente de la orden quedó anulado; las bobinas vuelven a estar abiertas');
      setCancelling(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo anular la orden'),
  });

  const revert = useMutation({
    mutationFn: ({ coilId, reason }: { coilId: string; reason: string }) =>
      api<CuttingOrderDto>(`/cutting/${id}/coils/${coilId}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('La recepción quedó revertida: la bobina vuelve a estar en el tercero');
      setReverting(null);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo revertir la recepción'),
  });

  if (order.isPending) return <Skeleton className="h-64 w-full" />;
  if (order.isError || !order.data) {
    return <p className="text-destructive">No se pudo cargar la orden de corte.</p>;
  }

  const o = order.data;
  const hasPending = o.coils.some((c) => c.status === 'SENT');
  const canCancel = hasPending && o.status !== 'CANCELLED' && o.status !== 'RECEIVED';

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{o.supplierName}</h1>
          <p className="text-sm text-muted-foreground">
            {BUSINESS_LINE_LABELS[o.businessLine]} · enviada el{' '}
            {new Date(o.sentAt).toLocaleDateString('es-PE')}
            {o.notes && <> · {o.notes}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={o.status === 'CANCELLED' ? 'outline' : 'secondary'}>
            {CUTTING_ORDER_STATUS_LABELS[o.status]}
          </Badge>
          <Button variant="outline" asChild>
            <Link href={`/compras/nueva?tipo=SERVICE&ordenCorte=${o.id}&linea=${o.businessLine}`}>
              Vincular factura del corte
            </Link>
          </Button>
          {canCancel && (
            <Button
              variant="destructive"
              onClick={() => {
                setCancelling(true);
              }}
            >
              Cancelar lo pendiente
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bobinas de la orden</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bobina</TableHead>
                <TableHead>Plan de anchos</TableHead>
                <TableHead>Recibido</TableHead>
                <TableHead className="text-right">Merma</TableHead>
                <TableHead>Flejes</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.coils.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      className="font-mono underline underline-offset-4"
                      href={`/bobinas/${row.coilId}`}
                    >
                      {row.coilCode}
                    </Link>
                    <div className="text-xs text-muted-foreground">{row.coilWidthMm} mm</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.widthPlanMm.map((p) => `${p.widthMm}×${p.stripsCount}`).join(', ')}
                    <div className="text-xs text-muted-foreground">
                      merma esperada {row.expectedKerfLossMm} mm
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.receivedWidthsMm ? (
                      <>
                        {row.receivedWidthsMm
                          .map((p) => `${p.widthMm}×${p.stripsCount}`)
                          .join(', ')}
                        <div className="text-xs text-muted-foreground">
                          {row.receivedWeightKg ? formatQty(row.receivedWeightKg, 'kg') : '—'}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {row.receivedKerfLossKg ? formatQty(row.receivedKerfLossKg, 'kg') : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {row.strips.map((s) => (
                        <Link
                          key={s.id}
                          className="font-mono text-xs underline underline-offset-4"
                          href={`/bobinas/${s.id}`}
                        >
                          {s.code} ({s.widthMm} mm · {formatQty(s.weightKg, 'kg')})
                        </Link>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.status === 'SENT' ? 'outline' : 'secondary'}>
                      {CUTTING_ORDER_COIL_STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === 'SENT' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setReceiving(row);
                        }}
                      >
                        Recibir
                      </Button>
                    )}
                    {row.status === 'RECEIVED' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setReverting(row);
                        }}
                      >
                        Revertir
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Servicios de corte imputados (RF-41)</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Comprobante</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Monto imputado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.services.map((s) => (
                <TableRow key={s.purchaseId}>
                  <TableCell>
                    <Link
                      className="underline underline-offset-4"
                      href={`/compras/${s.purchaseId}`}
                    >
                      {s.documentLabel}
                    </Link>
                  </TableCell>
                  <TableCell>{s.status}</TableCell>
                  <TableCell className="text-right">{formatMoney(s.amountPen)}</TableCell>
                </TableRow>
              ))}
              {o.services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    Todavía no se vinculó ninguna factura de corte a esta orden.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {receiving && (
        <CuttingReceiveDialog
          cuttingOrderId={o.id}
          row={receiving}
          open={receiving !== null}
          onOpenChange={(open) => {
            if (!open) setReceiving(null);
          }}
          onDone={invalidate}
        />
      )}

      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancelar lo pendiente de la orden"
        description="Las bobinas que todavía no volvieron del tercero quedan abiertas otra vez (RF-22). Lo ya recibido no se toca."
        confirmLabel="Sí, cancelar"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          cancel.mutate(reason);
        }}
      />

      <ReasonDialog
        open={reverting !== null}
        onOpenChange={(open) => {
          if (!open) setReverting(null);
        }}
        title="Revertir la recepción"
        description={
          reverting
            ? `Los flejes de ${reverting.coilCode} (${reverting.strips.map((s) => s.code).join(', ')}) quedan anulados y su peso vuelve a la bobina madre, que regresa a "en el tercero". Solo se puede si ningún fleje se movió después.`
            : ''
        }
        confirmLabel="Sí, revertir"
        pending={revert.isPending}
        onConfirm={(reason) => {
          if (reverting) revert.mutate({ coilId: reverting.coilId, reason });
        }}
      />
    </RoleGate>
  );
}
