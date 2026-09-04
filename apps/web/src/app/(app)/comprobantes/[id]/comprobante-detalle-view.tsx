'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_REASONS,
  FISCAL_DOC_TYPE_LABELS,
  FULL_CREDIT_NOTE_REASONS,
  PAYMENT_TERMS_LABELS,
  Role,
  businessToday,
  type CreditNoteReason,
  type FiscalDocumentDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatMoney, formatQty, unitSymbol } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { FiscalDocumentStatusBadge } from '@/components/invoicing/status-badges';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-70/RF-74/RF-75/RF-76: detalle del comprobante y sus acciones fiscales. */
export function ComprobanteDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [voidOpen, setVoidOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditReason, setCreditReason] = useState<CreditNoteReason>('ANULACION_OPERACION');
  const [creditQty, setCreditQty] = useState<Record<string, string>>({});

  const document = useQuery({
    queryKey: ['fiscal-document', id],
    queryFn: () => api<FiscalDocumentDto>(`/invoicing/documents/${id}`),
  });
  const d = document.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }
  function refresh(): void {
    invalidateInvoicing(queryClient, { documentId: id, orderId: d?.salesOrderId ?? undefined });
  }

  const send = useMutation({
    mutationFn: () => api<FiscalDocumentDto>(`/invoicing/documents/${id}/send`, { method: 'POST' }),
    onSuccess: (result) => {
      // El mensaje dice el desenlace real y no "listo": con el PSE caído el documento sale
      // igual (D-073) y el usuario tiene que saber que todavía no está declarado.
      if (result.status === 'ACCEPTED') toast.success(`${result.number} aceptado por SUNAT`);
      else if (result.status === 'REJECTED') toast.error(`SUNAT rechazó ${result.number}`);
      else
        toast.warning(`${result.number} quedó emitido y pendiente de envío; ya puedes despachar`);
      refresh();
    },
    onError,
  });

  const retry = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/retry`, { method: 'POST' }),
    onSuccess: (result) => {
      if (result.status === 'ACCEPTED') toast.success('Aceptado por SUNAT');
      else toast.warning('Sigue pendiente: el envío no entró todavía');
      refresh();
    },
    onError,
  });

  const refreshStatus = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Estado consultado al PSE');
      refresh();
    },
    onError,
  });

  const correct = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/correct`, { method: 'POST' }),
    onSuccess: (created) => {
      toast.success('Se creó un borrador corregido con correlativo nuevo');
      refresh();
      window.location.href = `/comprobantes/${created.id}`;
    },
    onError,
  });

  const voidDocument = useMutation({
    mutationFn: (reason: string) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/void`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (result) => {
      toast.success(
        result.status === 'VOIDED'
          ? 'Comprobante dado de baja'
          : 'Baja comunicada: SUNAT todavía no la confirma',
      );
      setVoidOpen(false);
      refresh();
    },
    onError,
  });

  const creditNote = useMutation({
    mutationFn: () => {
      const items = Object.entries(creditQty)
        .filter(([, qty]) => qty.trim() !== '' && Number(qty) > 0)
        .map(([affectedItemId, qty]) => ({ affectedItemId, qty: qty.trim() }));
      return api<FiscalDocumentDto>(`/invoicing/documents/${id}/credit-note`, {
        method: 'POST',
        body: {
          reason: creditReason,
          issueDate: businessToday(),
          // Sin líneas es total; con líneas, parcial (RF-76).
          ...(items.length > 0 ? { items } : {}),
        },
      });
    },
    onSuccess: (created) => {
      toast.success('Nota de crédito creada en borrador: revísala y emítela');
      setCreditOpen(false);
      setCreditQty({});
      refresh();
      window.location.href = `/comprobantes/${created.id}`;
    },
    onError,
  });

  if (document.isPending) return <Skeleton className="h-64 w-full" />;
  if (document.isError || !d) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar el comprobante.</AlertDescription>
      </Alert>
    );
  }

  const isDraft = d.status === 'DRAFT';
  const canRetry = d.status === 'ISSUED' || d.status === 'SEND_ERROR';
  const canCorrect = d.status === 'REJECTED';
  const canVoid = isAdmin && d.voidPath === 'VOID';
  const canCreditNote =
    d.status === 'ACCEPTED' &&
    d.docType !== 'NOTA_CREDITO' &&
    d.docType !== 'GUIA_REMISION_REMITENTE';
  const isFullReason = FULL_CREDIT_NOTE_REASONS.includes(creditReason);

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{d.number ?? 'Borrador'}</h1>
            <FiscalDocumentStatusBadge status={d.status} isStalled={d.isStalled} />
          </div>
          <p className="text-sm text-muted-foreground">
            {FISCAL_DOC_TYPE_LABELS[d.docType]} · {d.customerName} · {d.customerDocNumber}
            {d.salesOrderId && (
              <>
                {' · '}
                <Link href={`/pedidos/${d.salesOrderId}`} className="underline">
                  {d.salesOrderCode}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDraft && (
            <Button
              disabled={send.isPending}
              onClick={() => {
                send.mutate();
              }}
            >
              Emitir y enviar al PSE
            </Button>
          )}
          {canRetry && (
            <Button
              variant="outline"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate();
              }}
            >
              Reintentar envío
            </Button>
          )}
          {!isDraft && (
            <Button
              variant="outline"
              disabled={refreshStatus.isPending}
              onClick={() => {
                refreshStatus.mutate();
              }}
            >
              Consultar al PSE
            </Button>
          )}
          {canCorrect && (
            <Button
              disabled={correct.isPending}
              onClick={() => {
                correct.mutate();
              }}
            >
              Corregir y reemitir
            </Button>
          )}
          {canCreditNote && (
            <Button
              variant="outline"
              onClick={() => {
                setCreditOpen(true);
              }}
            >
              Nota de crédito
            </Button>
          )}
          {canVoid && (
            <Button
              variant="destructive"
              onClick={() => {
                setVoidOpen(true);
              }}
            >
              Dar de baja
            </Button>
          )}
        </div>
      </div>

      {/* Los avisos de estado. Cada uno dice qué pasó y qué hacer, no solo qué pasó. */}
      {d.status === 'ISSUED' && (
        <Alert variant={d.isStalled ? 'destructive' : 'default'}>
          <AlertDescription>
            El comprobante tiene número y ya permite despachar, pero el PSE todavía no lo aceptó
            {d.isStalled ? ' y lleva demasiado tiempo así' : ''}. El sistema reintenta solo cada 15
            minutos; «Reintentar envío» lo empuja ahora.
            {d.lastSendError && <> Último error: {d.lastSendError}</>}
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'SEND_ERROR' && (
        <Alert variant="destructive">
          <AlertDescription>
            El envío falló: {d.lastSendError ?? 'sin detalle'}. El correlativo {d.number} ya está
            tomado y se reutiliza en cada reintento; no hace falta crear otro comprobante.
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'REJECTED' && (
        <Alert variant="destructive">
          <AlertDescription>
            SUNAT rechazó el comprobante{d.rejectionCode ? ` (${d.rejectionCode})` : ''}:{' '}
            {d.rejectionMessage ?? 'sin detalle'}. El número {d.number} queda en el historial;
            «Corregir y reemitir» crea un borrador nuevo que tomará otro correlativo.
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'VOID_PENDING' && (
        <Alert>
          <AlertDescription>
            La baja está comunicada y SUNAT todavía no la confirmó. «Consultar al PSE» revisa si ya
            respondió.
          </AlertDescription>
        </Alert>
      )}
      {d.replacesDocumentNumber && (
        <Alert>
          <AlertDescription>
            Este comprobante corrige a {d.replacesDocumentNumber}, que fue rechazado y conserva su
            propio número.
          </AlertDescription>
        </Alert>
      )}
      {d.genericCustomerOverrideByName && (
        <Alert>
          <AlertDescription>
            Boleta a «público en general» por encima del tope de SUNAT, autorizada por{' '}
            {d.genericCustomerOverrideByName}.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emisión</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatDate(d.issueDate)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {PAYMENT_TERMS_LABELS[d.paymentTerms]}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg">
            {d.dueDate ? (
              <span className={d.isOverdue ? 'text-destructive' : undefined}>
                {formatDate(d.dueDate)}
              </span>
            ) : (
              '—'
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{formatMoney(d.totalPen)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Saldo</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{formatMoney(d.balancePen)}</CardContent>
        </Card>
      </div>

      {(d.hasPdf || d.hasXml || d.hasCdr) && (
        <div className="flex flex-wrap gap-2">
          {d.hasPdf && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/pdf`}>Descargar PDF</a>
            </Button>
          )}
          {d.hasXml && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/xml`}>Descargar XML</a>
            </Button>
          )}
          {d.hasCdr && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/cdr`}>Descargar CDR</a>
            </Button>
          )}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Líneas</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">P. unitario</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">IGV</TableHead>
                <TableHead className="text-right">Acreditado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.productSku ?? item.description}</div>
                    {item.productSku && (
                      <div className="text-xs text-muted-foreground">{item.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.unitPricePen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(item.subtotalPen)}</TableCell>
                  <TableCell className="text-right">{formatMoney(item.igvPen)}</TableCell>
                  <TableCell className="text-right">
                    {Number(item.creditedQty) > 0 ? formatQty(item.creditedQty, '') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end gap-6 text-sm">
          <span>Subtotal {formatMoney(d.subtotalPen)}</span>
          <span>IGV {formatMoney(d.igvPen)}</span>
          <span className="font-semibold">Total {formatMoney(d.totalPen)}</span>
        </div>
      </section>

      {d.creditNotes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Notas de crédito</h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.creditNotes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <Link
                        href={`/comprobantes/${n.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {n.number ?? 'Borrador'}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(n.issueDate)}</TableCell>
                    <TableCell>
                      <FiscalDocumentStatusBadge status={n.status} />
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(n.totalPen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {d.affectedDocumentNumber && (
        <div className="text-sm text-muted-foreground">
          Afecta a{' '}
          <Link href={`/comprobantes/${d.affectedDocumentId}`} className="underline">
            {d.affectedDocumentNumber}
          </Link>
          {d.creditNoteReason && <> · {CREDIT_NOTE_REASON_LABELS[d.creditNoteReason]}</>}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Creado por {d.createdByName ?? '—'} el {formatDate(d.createdAt.slice(0, 10))}.
        {d.sunatHash && <> Hash SUNAT: {d.sunatHash}.</>}
        {d.sendAttempts > 0 && <> Intentos de envío: {d.sendAttempts}.</>}
      </div>

      <ReasonDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Dar de baja ${d.number ?? ''}`}
        description="Comunica la baja a SUNAT: el comprobante se da por no emitido y su saldo pasa a cero. Fuera del plazo o con efecto económico, lo que corresponde es una nota de crédito."
        confirmLabel="Comunicar la baja"
        pending={voidDocument.isPending}
        onConfirm={(reason) => {
          voidDocument.mutate(reason);
        }}
      />

      <Dialog open={creditOpen} onOpenChange={setCreditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nota de crédito sobre {d.number}</DialogTitle>
            <DialogDescription>
              Sin cantidades es una nota <strong>total</strong>: acredita todo lo que quede sin
              acreditar. Escribe cantidades para acreditar solo una parte.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Motivo (catálogo 09 de SUNAT)</Label>
              <Select
                value={creditReason}
                onValueChange={(v) => {
                  setCreditReason(v as CreditNoteReason);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_NOTE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {CREDIT_NOTE_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!isFullReason && (
                <p className="text-xs text-muted-foreground">
                  Este motivo describe un ajuste parcial: conviene indicar cantidades por línea.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Cantidades a acreditar (opcional)</Label>
              {d.items.map((item) => {
                const pending = Number(item.qty) - Number(item.creditedQty);
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <span className="flex-1 text-sm">
                      {item.productSku ?? item.description}
                      <span className="ml-2 text-xs text-muted-foreground">
                        quedan {pending.toFixed(3)} {unitSymbol(item.unit)}
                      </span>
                    </span>
                    <Input
                      className="w-32"
                      inputMode="decimal"
                      placeholder="Total"
                      value={creditQty[item.id] ?? ''}
                      onChange={(e) => {
                        setCreditQty((prev) => ({ ...prev, [item.id]: e.target.value }));
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreditOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              disabled={creditNote.isPending}
              onClick={() => {
                creditNote.mutate();
              }}
            >
              Crear borrador de nota de crédito
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RoleGate>
  );
}
