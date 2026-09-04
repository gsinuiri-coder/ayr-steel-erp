'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BUSINESS_LINE_LABELS, type QuotationDto, type SalesOrderDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
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
import { quotationStatusBadge } from '../cotizaciones-view';

/** RF-61/RF-62/RF-65: detalle de una cotización con sus acciones de estado. */
export function CotizacionDetalleView({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);

  const quotation = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api<QuotationDto>(`/sales/quotations/${id}`),
  });
  const q = quotation.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }

  const emit = useMutation({
    mutationFn: () => api<QuotationDto>(`/sales/quotations/${id}/emit`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Cotización emitida');
      invalidateSales(queryClient, { quotationId: id });
    },
    onError,
  });

  const confirm = useMutation({
    mutationFn: () => api<SalesOrderDto>(`/sales/quotations/${id}/confirm`, { method: 'POST' }),
    onSuccess: (order) => {
      toast.success(`Pedido ${order.code} creado con su reserva`);
      invalidateSales(queryClient, { quotationId: id, orderId: order.id });
      router.push(`/pedidos/${order.id}`);
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

  const busy = emit.isPending || confirm.isPending || cancel.isPending;
  const canEmit = q.status === 'DRAFT';
  const canConfirm = q.status === 'EMITTED' && !q.isExpired;
  const canCancel = q.status !== 'CONFIRMED' && q.status !== 'CANCELLED';

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{q.code}</h1>
            {quotationStatusBadge(q.status, q.isExpired)}
          </div>
          <p className="text-sm text-muted-foreground">
            {q.customerName} · {q.customerDocNumber} · {BUSINESS_LINE_LABELS[q.businessLine]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {q.pdfKey && (
            <Button variant="outline" asChild>
              {/* Descarga directa desde el API (D-068); el proxy `/api/*` reenvía el binario. */}
              <a href={`/api/sales/quotations/${q.id}/pdf`}>Descargar PDF</a>
            </Button>
          )}
          {canEmit && (
            <Button
              disabled={busy}
              onClick={() => {
                emit.mutate();
              }}
            >
              Emitir
            </Button>
          )}
          {canConfirm && (
            <Button
              disabled={busy}
              onClick={() => {
                confirm.mutate();
              }}
            >
              Confirmar y reservar
            </Button>
          )}
          {canCancel && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setCancelOpen(true);
              }}
            >
              Anular
            </Button>
          )}
        </div>
      </div>

      {q.status === 'EMITTED' && q.isExpired && (
        <Alert variant="destructive">
          <AlertDescription>
            La vigencia venció el {formatDate(q.validUntil)}: la cotización ya no se puede
            confirmar. Crea una nueva con la fecha vigente.
          </AlertDescription>
        </Alert>
      )}

      {q.salesOrderId && (
        <Alert>
          <AlertDescription>
            Confirmada. Generó el pedido{' '}
            <Link href={`/pedidos/${q.salesOrderId}`} className="font-medium underline">
              {q.salesOrderCode}
            </Link>{' '}
            con su reserva de material.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emisión</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatDate(q.issueDate)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Válida hasta
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatDate(q.validUntil)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Subtotal</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatMoney(q.subtotalPen)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total (con IGV)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{formatMoney(q.totalPen)}</CardContent>
        </Card>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">P. lista</TableHead>
              <TableHead className="text-right">P. cotizado</TableHead>
              <TableHead>Reservará</TableHead>
              <TableHead className="text-right">Importe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.items.map((item) => {
              const discounted =
                item.listPricePen !== null && item.listPricePen !== item.unitPricePen;
              return (
                <TableRow key={item.id}>
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.productSku}</div>
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {item.listPricePen === null ? '—' : formatMoney(item.listPricePen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={discounted ? 'font-medium text-amber-600' : undefined}>
                      {formatMoney(item.unitPricePen, 'PEN', 4)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.reserveItemLabel || item.reserveItemId}
                    <span className="block text-muted-foreground">
                      {formatQty(item.reserveQty, unitSymbol(item.reserveUnit))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(item.subtotalPen)}</TableCell>
                </TableRow>
              );
            })}
            {q.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  La cotización no tiene líneas.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {q.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observaciones</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{q.notes}</CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Creada por {q.createdByName ?? '—'} el {formatDate(q.createdAt.slice(0, 10))}.
        {q.cancelledAt && (
          <Badge variant="outline" className="ml-2">
            Anulada
          </Badge>
        )}
      </div>

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
    </>
  );
}
