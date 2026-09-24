'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  Role,
  toDecimal,
  type QuotationDto,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatQty, formatTimestampDate, unitSymbol } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AuditHistoryLink } from '@/components/audit-history-link';
import { HeaderActions } from '@/components/header-actions';
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
import { Stat, StatStrip } from '@/components/stat-strip';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { ConfirmQuotationDialog } from '@/components/sales/confirm-quotation-dialog';
import { QuotationStatusBadge } from '@/components/sales/status-badges';
import {
  formatExpiry,
  remainingLabel,
  TemporaryReservationLines,
} from '@/components/sales/temporary-reservation';
import { PriceChangesCard } from '@/components/sales/price-changes-card';
import { cn, customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';

/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-61/RF-62/RF-65: detalle de una cotización con sus acciones de estado. */
export function CotizacionDetalleView({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const quotation = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api<QuotationDto>(`/sales/quotations/${id}`),
  });
  const q = quotation.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }

  const confirm = useMutation({
    mutationFn: () => api<SalesOrderDto>(`/sales/quotations/${id}/confirm`, { method: 'POST' }),
    onSuccess: (order) => {
      toast.success(`Pedido ${order.code} creado con su reserva y sus órdenes`);
      setConfirmOpen(false);
      invalidateSales(queryClient, { quotationId: id, orderId: order.id });
      router.push(`/pedidos/${order.id}`);
    },
    onError: (err: unknown) => {
      onError(err);
      // Entre la vista previa y el clic otro pudo tomar el material: se relee para que el
      // diálogo muestre el bloqueo nuevo en vez de ofrecer otra vez el mismo botón.
      void queryClient.invalidateQueries({ queryKey: ['confirm-preview', id] });
    },
  });

  // D-185: apartar el material mientras el cliente deposita.
  const reserve = useMutation({
    mutationFn: () => api<QuotationDto>(`/sales/quotations/${id}/reserve`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Material reservado temporalmente');
      invalidateSales(queryClient, { quotationId: id });
    },
    onError,
  });

  const releaseTemporary = useMutation({
    mutationFn: (reason: string) =>
      api<QuotationDto>(`/sales/quotations/${id}/release-reservation`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Reserva temporal liberada');
      setReleaseOpen(false);
      invalidateSales(queryClient, { quotationId: id });
    },
    onError,
  });

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<QuotationDto>(`/sales/quotations/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Cotización anulada');
      setCancelOpen(false);
      invalidateSales(queryClient, { quotationId: id });
    },
    onError,
  });

  // D-119: duplicar crea una cotización nueva en cualquier estado — la única acción de esta
  // pantalla que no depende de `q.status`. D-184: nace emitida, igual que cualquier alta.
  const duplicate = useMutation({
    mutationFn: () => api<QuotationDto>(`/sales/quotations/${id}/duplicate`, { method: 'POST' }),
    onSuccess: (created) => {
      toast.success(`Cotización ${created.code} creada`);
      invalidateSales(queryClient);
      router.push(`/cotizaciones/${created.id}`);
    },
    onError,
  });

  if (quotation.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (quotation.isError || !q) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar la cotización.</AlertDescription>
      </Alert>
    );
  }

  const busy =
    confirm.isPending ||
    cancel.isPending ||
    duplicate.isPending ||
    reserve.isPending ||
    releaseTemporary.isPending;
  const canConfirm = q.status === 'EMITTED' && !q.isExpired;
  const canReserve = canConfirm && q.temporaryReservation === null;
  const canCancel = q.status !== 'CONFIRMED' && q.status !== 'CANCELLED';
  // D-184: editable mientras no esté confirmada. Una vencida también: editarla es renovarla.
  const canEdit = q.status !== 'CONFIRMED' && q.status !== 'CANCELLED';

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">{q.code}</h1>
            <QuotationStatusBadge status={q.status} isExpired={q.isExpired} />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={customerSearchHref(q.customerDocNumber)} className={LINK_CLASSNAME}>
              {q.customerName}
            </Link>{' '}
            · {q.customerDocNumber} · {/* D-119: una cotización puede mezclar líneas de negocio. */}
            {q.businessLines.map((b) => BUSINESS_LINE_LABELS[b]).join(', ')}
          </p>
        </div>
        {/*
          F8-S3b/M3: principal + «⋯». Principal: confirmar mientras se pueda (es a lo que va la
          cotización); si no, editar; si tampoco, el PDF. Duplicar funciona en cualquier estado
          (D-119). La descarga es directa desde el API (D-068), no depende de `pdfKey`.
        */}
        <div className="flex items-center gap-2">
          <AuditHistoryLink entityType="quotations" entityId={q.id} />
          <HeaderActions
            primary={['confirm', 'edit', 'pdf']}
            actions={[
              { key: 'pdf', label: 'Descargar PDF', download: `/api/sales/quotations/${q.id}/pdf` },
              { key: 'edit', label: 'Editar', show: canEdit, href: `/cotizaciones/${q.id}/editar` },
              {
                key: 'reserve',
                label: 'Reservar',
                show: canReserve,
                disabled: busy,
                pending: reserve.isPending,
                pendingText: 'Reservando…',
                onSelect: () => {
                  if (busy) return;
                  reserve.mutate();
                },
              },
              {
                key: 'confirm',
                label: 'Confirmar',
                show: canConfirm,
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setConfirmOpen(true);
                },
              },
              {
                key: 'duplicate',
                label: 'Duplicar',
                disabled: busy,
                pending: duplicate.isPending,
                pendingText: 'Duplicando…',
                onSelect: () => {
                  if (busy) return;
                  duplicate.mutate();
                },
              },
              {
                key: 'cancel',
                label: 'Anular',
                show: canCancel,
                destructive: true,
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setCancelOpen(true);
                },
              },
            ]}
          />
        </div>
      </div>

      {q.status === 'EMITTED' && q.isExpired && (
        <Alert variant="destructive">
          <AlertDescription>
            La vigencia venció el {formatDate(q.validUntil)}: la cotización ya no se puede
            confirmar. Edítala con una vigencia nueva para renovarla.
          </AlertDescription>
        </Alert>
      )}

      {q.temporaryReservation && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
            <div>
              <CardTitle className="text-sm">Reserva temporal</CardTitle>
              <p className="text-xs text-muted-foreground">
                Vence {formatExpiry(q.temporaryReservation.expiresAt)} · queda{' '}
                <span className="font-medium text-foreground">
                  {remainingLabel(q.temporaryReservation.expiresAt)}
                </span>
                {q.temporaryReservation.createdByName
                  ? ` · la hizo ${q.temporaryReservation.createdByName}`
                  : ''}
                . Confirmar la convierte en firme.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setReleaseOpen(true);
              }}
            >
              Liberar
            </Button>
          </CardHeader>
          <CardContent>
            <TemporaryReservationLines lines={q.temporaryReservation.lines} />
          </CardContent>
        </Card>
      )}

      {q.salesOrderId && (
        <Alert>
          <AlertDescription>
            Confirmada. Generó el pedido{' '}
            <Link href={`/pedidos/${q.salesOrderId}`} className={cn('font-medium', LINK_CLASSNAME)}>
              {q.salesOrderCode}
            </Link>{' '}
            con su reserva de material.
          </AlertDescription>
        </Alert>
      )}

      <StatStrip>
        <Stat label="Emisión">{formatDate(q.issueDate)}</Stat>
        {/* D-157: sin vencimiento no es una fecha faltante, es una cotización que no vence
            (una importada). El guion de `formatDate` diría lo contrario. */}
        <Stat label="Válida hasta">
          {q.validUntil === null ? 'Sin vencimiento' : formatDate(q.validUntil)}
        </Stat>
        <Stat label="Subtotal">{formatMoney(q.subtotalPen)}</Stat>
        {/* El total es el número que se busca de un vistazo: es el único de los cuatro que
            va en semibold. */}
        <Stat label="Total (con IGV)" className="font-semibold">
          {formatMoney(q.totalPen)}
        </Stat>
      </StatStrip>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              {/* D-162: «valor» es sin IGV y «precio» es con IGV. Lo que la línea guarda y
                  lo que el comprobante factura es el valor, así que la columna lo dice. */}
              <TableHead className="text-right">Valor de lista</TableHead>
              <TableHead className="text-right">Valor cotizado</TableHead>
              <TableHead className="text-right">Valor de venta</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.items.map((item) => {
              const discounted =
                item.listPricePen !== null && item.listPricePen !== item.unitPricePen;
              return (
                <TableRow key={item.id} className="align-top">
                  <TableCell className="text-muted-foreground tabular-nums">
                    {item.lineNumber}
                  </TableCell>
                  {/*
                    La descripción de una línea a medida lleva los largos («3 de 4.20 m, …»)
                    y no entra en una sola línea: sin `whitespace-normal` se desbordaba de su
                    columna y se pintaba sobre la siguiente.
                  */}
                  <TableCell className="max-w-xs whitespace-normal">
                    <div className="font-medium">{item.productSku}</div>
                    {item.reserveItemType === 'COIL' && (
                      <div className="text-xs text-muted-foreground">
                        Bobina {item.reserveItemLabel}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {item.listPricePen === null ? '—' : formatMoney(item.listPricePen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className={discounted ? 'font-medium text-amber-600' : undefined}>
                      {formatMoney(item.unitPricePen, 'PEN', 4)}
                    </span>
                    {/* D-161: en una plancha lo que se negoció es el valor por metro; el
                        unitario sale de multiplicarlo por el largo del SKU. Mostrar solo el
                        unitario escondía justo el número que el vendedor y el cliente
                        acordaron. */}
                    {item.valuePerMeterPen !== null && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatMoney(item.valuePerMeterPen, 'PEN', 4)} /m
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(item.subtotalPen)}
                    {/*
                      D-169: en una línea importada el importe es el del comprobante, no
                      `cantidad × valor unitario`. Cuando las dos cifras no coinciden hay que
                      decirlo acá: si no, el importe se lee como una multiplicación mal hecha.
                    */}
                    {toDecimal(item.roundingAdjustmentPen).isZero() ? null : (
                      <span className="block text-xs font-normal text-muted-foreground">
                        Importe del comprobante ({formatMoney(item.roundingAdjustmentPen, 'PEN', 4)}{' '}
                        contra la multiplicación)
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {q.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  La cotización no tiene líneas.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* D-187: cada edición que movió un precio, con quién y cuándo. */}
      <PriceChangesCard changes={q.priceChanges} />

      {q.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observaciones</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{q.notes}</CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Creada por {q.createdByName ?? '—'} el {formatTimestampDate(q.createdAt)}.
        {q.cancelledAt && (
          <Badge variant="outline" className="ml-2">
            Anulada
          </Badge>
        )}
      </div>

      <ConfirmQuotationDialog
        quotationId={q.id}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        pending={confirm.isPending}
        onConfirm={() => {
          confirm.mutate();
        }}
      />

      <ReasonDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={`Liberar la reserva de ${q.code}`}
        description="El material vuelve a estar disponible. La cotización sigue emitida y se puede volver a reservar o confirmar."
        confirmLabel="Liberar reserva"
        pending={releaseTemporary.isPending}
        onConfirm={(reason) => {
          releaseTemporary.mutate(reason);
        }}
      />

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Anular ${q.code}`}
        description="La cotización queda anulada y no se puede confirmar. Queda registrada con su motivo (RF-95)."
        confirmLabel="Anular cotización"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          cancel.mutate(reason);
        }}
      />
    </RoleGate>
  );
}
