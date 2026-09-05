'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Role, TRANSFER_MODE_LABELS, type DispatchDto, type FiscalDocumentDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatQty, unitSymbol } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import {
  DispatchStatusBadge,
  FiscalDocumentStatusBadge,
} from '@/components/invoicing/status-badges';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;

/** RF-77..RF-79: detalle del despacho, su guía y su reversa. */
export function DespachoDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [reverseOpen, setReverseOpen] = useState(false);

  const dispatch = useQuery({
    queryKey: ['dispatch', id],
    queryFn: () => api<DispatchDto>(`/dispatches/${id}`),
  });
  const d = dispatch.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }
  function refresh(): void {
    invalidateInvoicing(queryClient, { dispatchId: id, orderId: d?.salesOrderId });
  }

  const issueNote = useMutation({
    mutationFn: () => api<FiscalDocumentDto>(`/dispatches/${id}/dispatch-note`, { method: 'POST' }),
    onSuccess: (note) => {
      // El mensaje dice el desenlace real: con el PSE caído la guía sale igual (D-073) y
      // el camión puede partir, pero SUNAT todavía no la vio.
      if (note.status === 'ACCEPTED') toast.success(`Guía ${note.number} aceptada por SUNAT`);
      else if (note.status === 'REJECTED') toast.error(`SUNAT rechazó la guía ${note.number}`);
      else toast.warning(`Guía ${note.number} emitida y pendiente de envío al PSE`);
      refresh();
    },
    onError,
  });

  const reverse = useMutation({
    mutationFn: (reason: string) =>
      api<DispatchDto>(`/dispatches/${id}/reverse`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Despacho revertido: el stock volvió al almacén');
      setReverseOpen(false);
      refresh();
    },
    onError,
  });

  if (dispatch.isPending) {
    return (
      <RoleGate allow={DISPATCH_ROLES}>
        <Skeleton className="h-64 w-full" />
      </RoleGate>
    );
  }
  if (dispatch.isError || !d) {
    return (
      <RoleGate allow={DISPATCH_ROLES}>
        <Alert variant="destructive">
          <AlertDescription>No se pudo cargar el despacho.</AlertDescription>
        </Alert>
      </RoleGate>
    );
  }

  const isLive = d.status === 'ISSUED';
  const noteBlocks =
    d.dispatchNoteStatus !== null &&
    d.dispatchNoteStatus !== 'REJECTED' &&
    d.dispatchNoteStatus !== 'VOIDED';
  const reverseBlockedBy = noteBlocks
    ? `la guía ${d.dispatchNoteNumber ?? ''} está vigente: dala de baja primero`
    : d.blockingDocumentNumbers.length > 0
      ? `el comprobante ${d.blockingDocumentNumbers.join(', ')} factura líneas de este despacho`
      : null;
  const canReverse = isAdmin && isLive && reverseBlockedBy === null;
  // Una guía rechazada o dada de baja no impide emitir otra: la que bloquea es la vigente.
  // D-103: un recojo en mostrador no tiene guía — el traslado es del comprador—, así que el
  // botón no aparece en vez de ofrecer una operación que el API rechaza.
  const canIssueNote =
    isLive &&
    d.transferMode !== 'PICKUP' &&
    (d.dispatchNoteStatus === null ||
      d.dispatchNoteStatus === 'REJECTED' ||
      d.dispatchNoteStatus === 'VOIDED');

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{d.code}</h1>
            <DispatchStatusBadge status={d.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {d.customerName} ·{' '}
            <Link href={`/pedidos/${d.salesOrderId}`} className="underline">
              {d.salesOrderCode}
            </Link>{' '}
            · {formatDate(d.dispatchDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canIssueNote && (
            <Button
              disabled={issueNote.isPending}
              onClick={() => {
                issueNote.mutate();
              }}
            >
              {d.dispatchNoteStatus === 'REJECTED' ? 'Reemitir guía' : 'Emitir guía de remisión'}
            </Button>
          )}
          {d.dispatchNoteId && (
            <Button variant="outline" asChild>
              <Link href={`/comprobantes/${d.dispatchNoteId}`}>Ver guía</Link>
            </Button>
          )}
          {canReverse && (
            <Button
              variant="destructive"
              onClick={() => {
                setReverseOpen(true);
              }}
            >
              Revertir despacho
            </Button>
          )}
        </div>
      </div>

      {/*
        El guardrail de D-074, dicho antes de que alguien escriba un motivo: deshacer una
        salida que un documento vigente ya declaró dejaría al kardex y a SUNAT contando
        cosas distintas.
      */}
      {isLive && reverseBlockedBy !== null && (
        <Alert>
          <AlertDescription>
            Este despacho no se puede revertir porque {reverseBlockedBy}. Resuelve el documento
            primero y vuelve.
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'REVERSED' && (
        <Alert>
          <AlertDescription>
            Revertido por {d.reversedByName ?? '—'} el{' '}
            {d.reversedAt ? formatDate(d.reversedAt.slice(0, 10)) : '—'}. El stock volvió al almacén
            y las reservas del pedido se restauraron.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Modalidad</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{TRANSFER_MODE_LABELS[d.transferMode]}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {d.transferMode === 'PRIVATE' ? 'Vehículo y conductor' : 'Transportista'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {d.transferMode === 'PRIVATE' ? (
              <>
                <div>{d.vehiclePlate}</div>
                <div className="text-muted-foreground">
                  {d.driverGivenNames} {d.driverFamilyNames} · {d.driverDocType} {d.driverDocNumber}{' '}
                  · Lic. {d.driverLicense}
                </div>
              </>
            ) : (
              <>
                <div>{d.carrierName}</div>
                <div className="text-muted-foreground">RUC {d.carrierDocNumber}</div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Peso bruto</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">
            {formatQty(d.totalWeightKg, 'kg')}
            {d.packageCount !== null && (
              <span className="ml-2 text-sm text-muted-foreground">{d.packageCount} bultos</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Guía</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {d.dispatchNoteStatus ? (
              <div className="space-y-1">
                <div>{d.dispatchNoteNumber ?? 'Borrador'}</div>
                <FiscalDocumentStatusBadge status={d.dispatchNoteStatus} />
              </div>
            ) : (
              <span className="text-muted-foreground">Todavía sin emitir</span>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Ruta</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <div className="text-muted-foreground">Partida</div>
            <div>
              {d.originAddress} <span className="text-muted-foreground">({d.originUbigeo})</span>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Llegada</div>
            <div>
              {d.destinationAddress}{' '}
              <span className="text-muted-foreground">({d.destinationUbigeo})</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Qué salió</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">Salió del kardex</TableHead>
                <TableHead className="text-right">Peso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.productSku}</div>
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.itemType === 'COIL' ? 'Bobina' : 'Producto'}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  {/* Lo que realmente salió del kardex, que no siempre es la cantidad de venta. */}
                  <TableCell className="text-right">{formatQty(item.reserveQty)}</TableCell>
                  <TableCell className="text-right">{formatQty(item.weightKg, 'kg')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {d.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observaciones</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{d.notes}</CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Despachado por {d.createdByName ?? '—'} el {formatDate(d.createdAt.slice(0, 10))}.
      </div>

      <ReasonDialog
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        title={`Revertir ${d.code}`}
        description="Devuelve el material al kardex, restaura las reservas del pedido y recalcula si el pedido sigue atendido. La fila del despacho no se borra: queda marcada como revertida."
        confirmLabel="Revertir despacho"
        pending={reverse.isPending}
        onConfirm={(reason) => {
          reverse.mutate(reason);
        }}
      />
    </RoleGate>
  );
}
