'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  RESERVATION_STALE_DAYS,
  RESERVATION_STATUS_LABELS,
  Role,
  type ReservationDto,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatMoney, formatQty, unitSymbol } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { SalesOrderStatusBadge } from '@/components/sales/status-badges';

function reservationBadge(r: ReservationDto) {
  const label = RESERVATION_STATUS_LABELS[r.status];
  if (r.status === 'ACTIVE') return <Badge>{label}</Badge>;
  if (r.status === 'CONSUMED') return <Badge variant="secondary">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}

/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** D-065/D-066: detalle del pedido, con la reserva visible y su liberación. */
export function PedidoDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [cancelOpen, setCancelOpen] = useState(false);
  const [releasing, setReleasing] = useState<ReservationDto | null>(null);

  const order = useQuery({
    queryKey: ['sales-order', id],
    queryFn: () => api<SalesOrderDto>(`/sales/orders/${id}`),
  });
  const o = order.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<SalesOrderDto>(`/sales/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Pedido anulado y reservas liberadas');
      setCancelOpen(false);
      invalidateSales(queryClient, { orderId: id, quotationId: o?.quotationId ?? undefined });
    },
    onError,
  });

  const release = useMutation({
    mutationFn: ({ reservationId, reason }: { reservationId: string; reason: string }) =>
      api<ReservationDto>(`/sales/reservations/${reservationId}/release`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Reserva liberada');
      setReleasing(null);
      invalidateSales(queryClient, { orderId: id });
    },
    onError,
  });

  if (order.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (order.isError || !o) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar el pedido.</AlertDescription>
      </Alert>
    );
  }

  const consumed = o.reservations.filter((r) => r.status === 'CONSUMED');
  const stale = o.reservations.filter((r) => r.isStale);
  // El botón se apaga cuando una OP viva está fabricando con el material: el propio aviso
  // de abajo dice que no se puede, y dejarlo habilitado terminaba en un diálogo con motivo
  // escrito y un toast de error.
  const blockedByProduction = o.reservations.some(
    (r) => r.productionOrderId !== null && r.status === 'CONSUMED',
  );
  const canCancel = o.status !== 'CANCELLED' && o.status !== 'FULFILLED' && !blockedByProduction;
  // Un pedido anulado no se despacha ni se factura; uno ya atendido tampoco se despacha,
  // pero sí se puede seguir facturando, así que el botón de comprobante vive con este
  // mismo permiso y el API es el que corta lo que ya no queda pendiente.
  const canOperate = o.status !== 'CANCELLED';

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{o.code}</h1>
            <SalesOrderStatusBadge status={o.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {o.customerName} · {o.customerDocNumber} · {BUSINESS_LINE_LABELS[o.businessLine]}
            {o.quotationId && (
              <>
                {' · '}
                <Link href={`/cotizaciones/${o.quotationId}`} className="underline">
                  {o.quotationCode}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/*
            Los dos actos que siguen al pedido, y que corren por separado (D-074):
            despachar saca la mercadería y cierra el pedido; facturar no lo cierra.
          */}
          {canOperate && (
            <>
              <Button asChild>
                <Link href={`/despachos/nuevo?pedido=${o.id}`}>Despachar</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/comprobantes/nuevo?pedido=${o.id}`}>Emitir comprobante</Link>
              </Button>
            </>
          )}
          {isAdmin && canCancel && (
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => {
                setCancelOpen(true);
              }}
            >
              Anular pedido
            </Button>
          )}
        </div>
      </div>

      {consumed.length > 0 && o.status !== 'CANCELLED' && (
        <Alert>
          <AlertDescription>
            {consumed.length === 1
              ? 'Una reserva ya fue consumida'
              : `${consumed.length} reservas ya fueron consumidas`}{' '}
            por producción: el pedido no se puede anular hasta revertir o anular esa orden.
          </AlertDescription>
        </Alert>
      )}
      {stale.length > 0 && (
        <Alert>
          <AlertDescription>
            {stale.length === 1 ? 'Una reserva lleva' : `${stale.length} reservas llevan`} más de{' '}
            {RESERVATION_STALE_DAYS} días activa sin consumirse. Si el pedido ya no va, conviene
            liberarla para devolver el material al disponible.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fecha</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatDate(o.issueDate)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Subtotal</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatMoney(o.subtotalPen)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">IGV</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatMoney(o.igvPen)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{formatMoney(o.totalPen)}</CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Líneas</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">P. unitario</TableHead>
                <TableHead className="text-right">Importe</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.productSku}</div>
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.unitPricePen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(item.subtotalPen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Reservas de material</h2>
        <p className="text-sm text-muted-foreground">
          Una reserva activa descuenta el disponible del ítem sin tocar el kardex (D-054): el
          material sigue físicamente en el almacén, pero ninguna otra operación lo puede tomar.
        </p>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ítem</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Orden de producción</TableHead>
                <TableHead>Creada</TableHead>
                {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.reservations.map((r) => (
                <TableRow key={r.id} className={r.status === 'RELEASED' ? 'opacity-60' : undefined}>
                  <TableCell>
                    <div className="font-medium">{r.itemLabel}</div>
                    <div className="text-xs text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(r.qty, unitSymbol(r.unit))}
                  </TableCell>
                  <TableCell>
                    {reservationBadge(r)}
                    {r.isStale && (
                      <Badge variant="outline" className="ml-2">
                        Vieja
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.productionOrderId ? (
                      <Link
                        href={`/produccion/${r.productionOrderId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {r.productionOrderCode}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDate(r.createdAt.slice(0, 10))}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      {r.status === 'ACTIVE' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setReleasing(r);
                          }}
                        >
                          Liberar
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {o.reservations.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={isAdmin ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    El pedido no tiene reservas.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {o.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observaciones</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{o.notes}</CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Creado por {o.createdByName ?? '—'} el {formatDate(o.createdAt.slice(0, 10))}.
      </div>

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Anular ${o.code}`}
        description="Libera las reservas activas y devuelve el material al disponible. Si el pedido vino de una cotización vigente, esa cotización vuelve a estar emitida."
        confirmLabel="Anular pedido"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          cancel.mutate(reason);
        }}
      />

      <ReasonDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null);
        }}
        title={`Liberar la reserva de ${releasing?.itemLabel ?? ''}`}
        description="El material vuelve al disponible y cualquier otra operación lo puede tomar. El pedido sigue vivo, pero deja de tener material comprometido."
        confirmLabel="Liberar reserva"
        pending={release.isPending}
        onConfirm={(reason) => {
          if (releasing) release.mutate({ reservationId: releasing.id, reason });
        }}
      />
    </RoleGate>
  );
}
