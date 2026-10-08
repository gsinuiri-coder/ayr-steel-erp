'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { errorMessage, toast } from '@/lib/notify';
import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  CURRENCIES,
  Decimal,
  CURRENCY_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_TERMS_LABELS,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_STATUS_LABELS,
  PURCHASE_TYPE_LABELS,
  PurchaseType,
  Role,
  SERVICE_KIND_LABELS,
  UNIT_LABELS,
  type Currency,
  type PurchaseDto,
  PURCHASE_NUMBER_MESSAGE,
  PURCHASE_NUMBER_PATTERN,
} from '@ayr/shared';
import { CrumbLabel } from '@/components/breadcrumb';
import { PURCHASE_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import type { ReverseArgs } from '@/lib/reverse-args';
import { formatDate, formatMoney, formatQty, isPositiveDecimal, todayIso } from '@/lib/format';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ReasonDialog } from '@/components/reason-dialog';
import { ANNUL_REASONS } from '@/lib/reasons';
import { EditReceivedPurchaseDialog } from '@/components/purchases/edit-received-purchase-dialog';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { HeaderActions } from '@/components/header-actions';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
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
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const paymentSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Monto inválido')
    .refine((v) => Number.parseFloat(v) > 0, 'Debe ser mayor a cero'),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string().trim().optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
});
type PaymentValues = z.infer<typeof paymentSchema>;

/** Detalle de una compra: recepción, cuenta por pagar y pagos parciales (D-030, D-039). */
export function CompraDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  // D-372 (cc14): editar la compra ya recibida, con vista previa y motivo.
  const [editingReceived, setEditingReceived] = useState(false);
  const [reversingPaymentId, setReversingPaymentId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<PurchaseItemView | null>(null);
  const [deletingItem, setDeletingItem] = useState<PurchaseItemView | null>(null);
  // F8-S1/M1: `PaymentForm` es un componente hijo con su propio `useMutation` — sin esto,
  // el `busy` de más abajo no sabía que "Guardar pago" estaba en vuelo, y "Recibir"/
  // "Anular"/"Editar documento" seguían habilitados mientras se registraba el pago.
  const [paymentPending, setPaymentPending] = useState(false);

  const purchase = useQuery({
    queryKey: ['purchase', id],
    queryFn: () => api<PurchaseDto>(`/purchases/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase', id] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    // Recibir o anular una compra cambia el detalle de cada bobina que creó.
    void queryClient.invalidateQueries({ queryKey: ['coil'] });
    // Registrar, anular un pago o anular la compra cambia el saldo que ve el proveedor.
    void queryClient.invalidateQueries({ queryKey: ['supplier-statement'] });
  };

  // D-124: la recepción es lo que mueve kardex y da de alta las bobinas, así que su fecha
  // de operación es la de todo lo que crea. Por defecto hoy; solo un administrador la mueve.
  const [receiveDate, setReceiveDate] = useState<string | undefined>(undefined);
  const receive = useMutation({
    mutationFn: (confirmBackdate: boolean) =>
      api<PurchaseDto>(`/purchases/${id}/receive`, {
        method: 'POST',
        body: { operationDate: receiveDate, confirmBackdate: confirmBackdate || undefined },
      }),
    onSuccess: () => {
      toast.success('Compra recibida: el stock ya está en el kardex');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo recibir')),
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await receive.mutateAsync(confirmBackdate);
  });

  const cancel = useMutation({
    mutationFn: ({ reason, operationDate }: ReverseArgs) =>
      api<PurchaseDto>(`/purchases/${id}/cancel`, {
        method: 'POST',
        body: { reason, operationDate },
      }),
    onSuccess: () => {
      toast.success('Compra anulada');
      setConfirmCancel(false);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo anular')),
  });

  // D-132: corregir serie y número del comprobante. No mueve nada —es el dato que
  // identifica el papel del proveedor—, y existe para poder limpiar los números con
  // sufijo inventado que dejó el defecto de unicidad que D-132 corrige.
  const updateDocument = useMutation({
    mutationFn: ({ series, number }: { series: string; number: string }) =>
      api<PurchaseDto>(`/purchases/${id}/document`, {
        method: 'PATCH',
        body: { series, number },
      }),
    onSuccess: () => {
      toast.success('Número de comprobante corregido');
      setEditingDocument(false);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo corregir el número')),
  });

  const reversePayment = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api<PurchaseDto>(`/purchases/${id}/payments/${paymentId}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Pago anulado: el monto vuelve a formar parte del saldo pendiente');
      setReversingPaymentId(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo anular el pago')),
  });

  // D-371: corregir o quitar una línea de una compra en borrador.
  const updateItem = useMutation({
    mutationFn: ({ itemId, qty, unitPrice }: { itemId: string; qty: string; unitPrice: string }) =>
      api<PurchaseDto>(`/purchases/${id}/items/${itemId}`, {
        method: 'PATCH',
        body: { qty, unitPrice },
      }),
    onSuccess: () => {
      toast.success('Línea corregida: los totales de la compra se recalcularon');
      setEditingItem(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo corregir la línea')),
  });
  const deleteItem = useMutation({
    mutationFn: (itemId: string) =>
      api<PurchaseDto>(`/purchases/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Línea eliminada: los totales de la compra se recalcularon');
      setDeletingItem(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo eliminar la línea')),
  });

  if (purchase.isPending) return <Skeleton className="h-64 w-full" />;
  if (purchase.isError || !purchase.data) {
    return <p className="text-destructive">No se pudo cargar la compra.</p>;
  }

  const p = purchase.data;
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const canReceive = user.role === Role.ADMINISTRADOR || user.role === Role.SUPERVISOR_PLANTA;
  const hasBalance = isPositiveDecimal(p.balance);
  // D-371: las líneas se corrigen solo en borrador (sin kardex) y sin pagos vigentes.
  const hasLivePayments = p.payments.some((payment) => !payment.reversedAt);
  const canEditItems = isAdmin && p.status === 'DRAFT' && !hasLivePayments;
  // F8-S1/M1: recibir, anular, corregir el número y anular un pago cambian la misma
  // compra; un `busy` combinado evita que dos de estas corran a la vez sobre ella.
  const busy =
    receive.isPending ||
    cancel.isPending ||
    updateDocument.isPending ||
    reversePayment.isPending ||
    updateItem.isPending ||
    deleteItem.isPending ||
    paymentPending;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <CrumbLabel label={p.documentLabel} />
          <h1 className="text-xl font-semibold">
            {PURCHASE_DOC_TYPE_LABELS[p.docType]} {p.documentLabel}
          </h1>
          <p className="text-xs text-muted-foreground">
            {p.supplierCode} — {p.supplierName} · {PURCHASE_TYPE_LABELS[p.type]} ·{' '}
            {BUSINESS_LINE_LABELS[p.businessLine]}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Badge variant={PURCHASE_TONE[p.status]} className="mt-2">
            {PURCHASE_STATUS_LABELS[p.status]}
          </Badge>
          {/*
            F8-S3b/M3: principal + «⋯». Principal: recibir el borrador, con su fecha de
            operación debajo (D-124); corregir el número y anular van al menú.
          */}
          <HeaderActions
            primary={['receive']}
            primaryFooter={<OperationDateField value={receiveDate} onChange={setReceiveDate} />}
            actions={[
              {
                key: 'receive',
                label: 'Recibir',
                show: canReceive && p.status === 'DRAFT',
                disabled: busy,
                pending: receive.isPending,
                pendingText: 'Recibiendo…',
                onSelect: () => {
                  if (busy) return;
                  void backdate.attempt();
                },
              },
              {
                key: 'edit-received',
                label: 'Editar compra',
                show: isAdmin && p.status === 'RECEIVED',
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setEditingReceived(true);
                },
              },
              {
                key: 'fix-number',
                label: 'Corregir número',
                show: isAdmin && p.status !== 'CANCELLED',
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setEditingDocument(true);
                },
              },
              {
                key: 'cancel',
                label: 'Anular',
                show: isAdmin && p.status !== 'CANCELLED',
                destructive: true,
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setConfirmCancel(true);
                },
              },
            ]}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Comprobante</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Emisión" value={formatDate(p.issueDate)} />
            <Row label="Condición" value={PAYMENT_TERMS_LABELS[p.paymentTerms]} />
            <Row label="Vencimiento" value={formatDate(p.dueDate)} />
            <Row label="Moneda" value={CURRENCY_LABELS[p.currency]} />
            {p.currency !== 'PEN' && (
              <Row
                label="Tipo de cambio"
                value={`${p.exchangeRate} (${p.exchangeRateSource === 'API' ? 'SUNAT' : 'manual'})`}
              />
            )}
            {p.serviceKind && <Row label="Servicio" value={SERVICE_KIND_LABELS[p.serviceKind]} />}
            {/* Landed cost (D-043): a qué compra de bobinas se imputa este servicio. */}
            {p.relatedPurchaseId && p.relatedPurchaseLabel && (
              <Row
                label="Se imputa a"
                value={
                  <Link className={LINK_CLASSNAME} href={`/compras/${p.relatedPurchaseId}`}>
                    {p.relatedPurchaseLabel}
                  </Link>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Importes</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Valor de venta" value={formatMoney(p.subtotal, p.currency)} />
            <Row label="IGV" value={formatMoney(p.igv, p.currency)} />
            <Row label="Total" value={formatMoney(p.total, p.currency)} />
            {p.currency !== 'PEN' && <Row label="Total en soles" value={formatMoney(p.totalPen)} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cuenta por pagar</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Pagado" value={formatMoney(p.paidAmount, p.currency)} />
            <Row label="Saldo" value={formatMoney(p.balance, p.currency)} />
            {isAdmin && hasBalance && p.status !== 'CANCELLED' && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-fit"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  setShowPaymentForm(true);
                }}
              >
                Registrar pago
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/*
        F8-S3b/M4: el formulario de pago dejó de abrirse en línea, entre los importes y el
        detalle, y pasó a un drawer: la compra sigue a la vista detrás. Mientras el pago viaja
        no se cierra, porque desmontar el formulario perdería el resultado de la mutación.
      */}
      <Sheet
        open={showPaymentForm}
        onOpenChange={(open) => {
          if (!open && paymentPending) return;
          setShowPaymentForm(open);
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto p-4 data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader className="p-0">
            <SheetTitle>Registrar pago</SheetTitle>
            <SheetDescription>
              Saldo pendiente: {formatMoney(p.balance, p.currency)}.
            </SheetDescription>
          </SheetHeader>
          <PaymentForm
            purchaseId={p.id}
            currency={p.currency}
            balance={p.balance}
            onPendingChange={setPaymentPending}
            onSaved={() => {
              setShowPaymentForm(false);
              invalidate();
            }}
          />
        </SheetContent>
      </Sheet>

      <Card>
        <CardHeader>
          <CardTitle>{p.type === PurchaseType.COIL ? 'Bobinas' : 'Detalle'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Descripción</TableHead>
                {p.type === PurchaseType.COIL && <TableHead>Medidas</TableHead>}
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">Precio unitario</TableHead>
                <TableHead className="text-right">Valor de venta</TableHead>
                {p.type === PurchaseType.COIL && <TableHead>Bobina</TableHead>}
                {canEditItems && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.items.map((item) => (
                <TableRow key={item.id} data-testid="linea-compra">
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    {item.productSku ? `${item.productSku} — ` : ''}
                    {item.description}
                  </TableCell>
                  {p.type === PurchaseType.COIL && (
                    <TableCell className="text-muted-foreground">
                      {item.finishCode} · {item.widthMm} × {item.thicknessMm} mm
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitLabel(item.unit))}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* P-14: el unitario a 4 decimales, la escala con la que se guarda. */}
                    {formatMoney(item.unitPrice, p.currency, 4)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.subtotal, p.currency)}
                  </TableCell>
                  {p.type === PurchaseType.COIL && (
                    <TableCell className="font-mono text-xs">
                      {item.coilId && item.coilCode ? (
                        <Link href={`/bobinas/${item.coilId}`} className={LINK_CLASSNAME}>
                          {item.coilCode}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  )}
                  {canEditItems && (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Editar la línea ${String(item.lineNumber)}`}
                        onClick={() => {
                          setEditingItem(item);
                        }}
                      >
                        Editar
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || p.items.length <= 1}
                        title={
                          p.items.length <= 1
                            ? 'Es la única línea: una compra sin líneas se anula'
                            : undefined
                        }
                        aria-label={`Eliminar la línea ${String(item.lineNumber)}`}
                        onClick={() => {
                          setDeletingItem(item);
                        }}
                      >
                        Eliminar
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isAdmin && p.status === 'DRAFT' && hasLivePayments && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              Las líneas no se editan mientras la compra tenga pagos vigentes: anula los pagos
              primero.
            </p>
          )}
        </CardContent>
      </Card>

      {p.landedCostServices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Servicios imputados al costo de las bobinas</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Comprobante</TableHead>
                  <TableHead>Servicio</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Monto sin IGV (S/)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.landedCostServices.map((service) => (
                  <TableRow key={service.purchaseId}>
                    <TableCell>
                      <Link className={LINK_CLASSNAME} href={`/compras/${service.purchaseId}`}>
                        {service.documentLabel}
                      </Link>
                    </TableCell>
                    <TableCell>{SERVICE_KIND_LABELS[service.serviceKind]}</TableCell>
                    <TableCell>
                      <Badge variant={PURCHASE_TONE[service.status]}>
                        {PURCHASE_STATUS_LABELS[service.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Solo una compra RECIBIDA llegó al kardex: en borrador es lo que
                          se imputará al recibirla, no lo que ya está en el costo. */}
                      {formatMoney(service.amountPen)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pagos</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Medio</TableHead>
                <TableHead>Referencia</TableHead>
                <TableHead className="text-right">Monto</TableHead>
                <TableHead>Estado</TableHead>
                {isAdmin && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.payments.map((payment) => (
                <TableRow
                  key={payment.id}
                  className={payment.reversedAt ? 'opacity-60' : undefined}
                >
                  <TableCell>{formatDate(payment.date)}</TableCell>
                  <TableCell>{PAYMENT_METHOD_LABELS[payment.method]}</TableCell>
                  <TableCell>{payment.reference ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(payment.amount, payment.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={payment.reversedAt ? 'outline' : 'secondary'}>
                      {payment.reversedAt ? 'Anulado' : 'Vigente'}
                    </Badge>
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      {!payment.reversedAt && p.status !== 'CANCELLED' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (busy) return;
                            setReversingPaymentId(payment.id);
                          }}
                        >
                          Anular pago
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {p.payments.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={isAdmin ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    Sin pagos registrados.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <div>
          <Button variant="outline" asChild>
            <Link href={`/proveedores/${p.supplierId}/estado-cuenta`}>
              Ver estado de cuenta del proveedor
            </Link>
          </Button>
        </div>
      )}

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={receive.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />

      <ReasonDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Anular la compra ${p.documentLabel}`}
        reasons={ANNUL_REASONS}
        description={
          p.status === 'RECEIVED'
            ? 'Se revierten todos los movimientos de kardex de la compra y sus bobinas quedan anuladas. Solo se puede si nada de lo que entró con ella se movió después.'
            : 'La compra queda anulada de forma permanente. No se puede deshacer.'
        }
        confirmLabel="Sí, anular"
        pending={cancel.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          // El diálogo se cierra en `onSuccess`: si el API rechaza la anulación —lo hace
          // cuando algo se movió después—, el motivo escrito no se pierde.
          cancel.mutate({ reason, operationDate });
        }}
      />

      {editingReceived && (
        <EditReceivedPurchaseDialog
          purchase={p}
          onClose={() => {
            setEditingReceived(false);
          }}
          onSaved={invalidate}
        />
      )}

      <DocumentNumberDialog
        open={editingDocument}
        onOpenChange={setEditingDocument}
        series={p.series}
        number={p.number}
        pending={updateDocument.isPending}
        onConfirm={(series, number) => {
          updateDocument.mutate({ series, number });
        }}
      />

      <PurchaseItemDialog
        key={editingItem?.id ?? 'sin-linea'}
        item={editingItem}
        currency={p.currency}
        pending={updateItem.isPending}
        onClose={() => {
          setEditingItem(null);
        }}
        onConfirm={(qty, unitPrice) => {
          if (editingItem) updateItem.mutate({ itemId: editingItem.id, qty, unitPrice });
        }}
      />

      <Dialog
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingItem(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar la línea {deletingItem?.lineNumber}</DialogTitle>
            <DialogDescription>
              {deletingItem?.description}. La compra está en borrador: no hay kardex que revertir.
              Los totales se recalculan y queda registrado en la auditoría.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeletingItem(null);
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              pending={deleteItem.isPending}
              pendingText="Eliminando…"
              onClick={() => {
                if (deletingItem) deleteItem.mutate(deletingItem.id);
              }}
            >
              Sí, eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={reversingPaymentId !== null}
        onOpenChange={(open) => {
          if (!open) setReversingPaymentId(null);
        }}
        title="Anular el pago"
        description="El monto vuelve a formar parte del saldo pendiente de la compra. No se puede deshacer."
        confirmLabel="Sí, anular"
        pending={reversePayment.isPending}
        onConfirm={(reason) => {
          if (reversingPaymentId) reversePayment.mutate({ paymentId: reversingPaymentId, reason });
        }}
      />
    </>
  );
}

/**
 * Corregir serie y número del comprobante (D-132).
 *
 * Es el único dato de la compra que se puede editar después de registrarla, y se puede
 * justamente porque no entra en ningún cálculo: identifica el papel del proveedor. Existe
 * para limpiar los números con sufijo inventado que dejó el defecto de unicidad —mientras
 * la unicidad contaba las compras anuladas, re-registrar una corregida obligaba a
 * inventarle un `-R` al número, y ese número inventado es el que después no cuadra.
 */
function DocumentNumberDialog({
  open,
  onOpenChange,
  series,
  number,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  series: string;
  number: string;
  pending: boolean;
  onConfirm: (series: string, number: string) => void;
}) {
  const [nextSeries, setNextSeries] = useState(series);
  const [nextNumber, setNextNumber] = useState(number);

  // Cada apertura arranca del valor guardado: si el API rechazó el cambio anterior, lo que
  // se ve tiene que ser lo que está en la base, no lo que se intentó.
  useEffect(() => {
    if (open) {
      setNextSeries(series);
      setNextNumber(number);
    }
  }, [open, series, number]);

  const seriesOk = /^[A-Za-z0-9]{1,10}$/.test(nextSeries.trim());
  const numberOk = PURCHASE_NUMBER_PATTERN.test(nextNumber.trim().toUpperCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corregir el número del comprobante</DialogTitle>
          <DialogDescription>
            Solo cambia cómo se identifica la factura del proveedor. No mueve costos, kardex ni
            saldos. Queda registrado en la auditoría.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="fix-series">Serie</Label>
            <Input
              id="fix-series"
              value={nextSeries}
              onChange={(e) => {
                setNextSeries(e.target.value.toUpperCase());
              }}
            />
            {!seriesOk && <p className="text-xs text-destructive">Serie inválida (ej: F001)</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fix-number">Número</Label>
            <Input
              id="fix-number"
              value={nextNumber}
              onChange={(e) => {
                setNextNumber(e.target.value);
              }}
            />
            {!numberOk && <p className="text-xs text-destructive">{PURCHASE_NUMBER_MESSAGE}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={pending || !seriesOk || !numberOk}
            onClick={() => {
              onConfirm(nextSeries.trim().toUpperCase(), nextNumber.trim());
            }}
          >
            {pending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PurchaseItemView = PurchaseDto['items'][number];

const QTY_PATTERN = /^\d+(\.\d{1,3})?$/;
const PRICE_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * D-371 — corregir cantidad y costo unitario de una línea de una compra en borrador. El
 * producto, la moneda y el TC no se tocan; el API recalcula la línea y los totales con la misma
 * cuenta del alta.
 */
function PurchaseItemDialog({
  item,
  currency,
  pending,
  onClose,
  onConfirm,
}: {
  item: PurchaseItemView | null;
  currency: Currency;
  pending: boolean;
  onClose: () => void;
  onConfirm: (qty: string, unitPrice: string) => void;
}) {
  // Cada apertura arranca de lo guardado: quien lo usa le pone `key` por línea, así que el
  // estado nace con los valores de la línea (sin un render vacío que muestre el error).
  const [qty, setQty] = useState(item?.qty ?? '');
  const [unitPrice, setUnitPrice] = useState(item?.unitPrice ?? '');

  const qtyOk = QTY_PATTERN.test(qty.trim()) && isPositiveDecimal(qty.trim());
  const priceOk = PRICE_PATTERN.test(unitPrice.trim()) && isPositiveDecimal(unitPrice.trim());
  // Guardar sin cambios recalcularía la línea como cantidad × precio y pisaría el importe del
  // papel de una compra importada (D-359): sin cambios no hay nada que guardar.
  const unchanged =
    item !== null &&
    qtyOk &&
    priceOk &&
    new Decimal(qty.trim()).equals(new Decimal(item.qty)) &&
    new Decimal(unitPrice.trim()).equals(new Decimal(item.unitPrice));

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar la línea {item?.lineNumber}</DialogTitle>
          <DialogDescription>
            {item?.description}. La compra está en borrador: solo cambian la cantidad y el costo
            unitario ({CURRENCY_LABELS[currency]}), y los totales se recalculan. Queda registrado en
            la auditoría.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="item-qty">Cantidad ({item ? unitLabel(item.unit) : ''})</Label>
            <Input
              id="item-qty"
              inputMode="decimal"
              value={qty}
              onChange={(e) => {
                setQty(e.target.value);
              }}
            />
            {!qtyOk && <p className="text-xs text-destructive">Mayor a cero, hasta 3 decimales</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="item-price">Precio unitario sin IGV</Label>
            <Input
              id="item-price"
              inputMode="decimal"
              value={unitPrice}
              onChange={(e) => {
                setUnitPrice(e.target.value);
              }}
            />
            {!priceOk && (
              <p className="text-xs text-destructive">Mayor a cero, hasta 4 decimales</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!qtyOk || !priceOk || unchanged}
            pending={pending}
            pendingText="Guardando…"
            onClick={() => {
              onConfirm(qty.trim(), unitPrice.trim());
            }}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Alta de un pago (D-039). Vive en su propio componente para montarse con la compra ya
 * cargada: así la moneda por defecto es la de la compra y no "Soles" del primer render.
 */
function PaymentForm({
  purchaseId,
  currency,
  balance,
  onPendingChange,
  onSaved,
}: {
  purchaseId: string;
  currency: Currency;
  balance: string;
  /** F8-S1/M1: para que el `busy` del padre cubra también esta mutación. */
  onPendingChange: (pending: boolean) => void;
  onSaved: () => void;
}) {
  const form = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      date: todayIso(),
      amount: '',
      currency,
      exchangeRate: '',
      method: 'TRANSFER',
      reference: '',
    },
  });
  const paymentCurrency = form.watch('currency');
  const crossCurrency = paymentCurrency !== currency;

  const paymentKey = useIdempotencyKey();
  const addPayment = useMutation({
    mutationFn: (values: PaymentValues) =>
      api<PurchaseDto>(`/purchases/${purchaseId}/payments`, {
        method: 'POST',
        body: {
          date: values.date,
          amount: values.amount,
          currency: values.currency,
          // cc33 N1: el TC solo viaja en un pago de otra moneda que la compra; en la misma
          // moneda el campo está escondido y un valor viejo no tiene que llegar al API.
          exchangeRate:
            values.currency !== currency && values.exchangeRate?.trim()
              ? values.exchangeRate.trim()
              : undefined,
          method: values.method,
          reference: values.reference?.trim() ? values.reference.trim() : undefined,
          idempotencyKey: paymentKey.current(),
        },
      }),
    onMutate: () => {
      onPendingChange(true);
    },
    onSettled: (_data, error) => {
      onPendingChange(false);
      paymentKey.settle(error ?? undefined);
    },
    onSuccess: () => {
      toast.success('Pago registrado');
      onSaved();
    },
    onError: (err) => {
      form.setError('root', {
        message: errorMessage(err, 'No se pudo registrar el pago'),
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo pago</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              // Sin conversión de por medio el saldo se puede comprobar acá y ahorrarle
              // al usuario el viaje al servidor; con monedas distintas manda el API.
              if (!crossCurrency && new Decimal(v.amount).gt(balance)) {
                form.setError('amount', {
                  message: `El pago excede el saldo pendiente (${formatMoney(balance, currency)})`,
                });
                return;
              }
              addPayment.mutate(v);
            })}
            className="grid gap-4 md:grid-cols-5"
            noValidate
          >
            {form.formState.errors.root && (
              <p role="alert" className="text-sm text-destructive md:col-span-5">
                {form.formState.errors.root.message}
              </p>
            )}
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fecha</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monto</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Moneda</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      if (value === currency) form.setValue('exchangeRate', '');
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CURRENCY_LABELS[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Medio</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {PAYMENT_METHOD_LABELS[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Referencia</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" placeholder="N.° de operación" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {crossCurrency && (
              <FormField
                control={form.control}
                name="exchangeRate"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Tipo de cambio</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        placeholder="Automático (SUNAT del día)"
                        {...field}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      El pago está en otra moneda que la compra. En blanco se usa el TC SUNAT de la
                      fecha del pago.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="md:col-span-5">
              <Button
                type="submit"
                disabled={addPayment.isPending}
                pending={addPayment.isPending}
                pendingText="Guardando…"
              >
                Guardar pago
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

/** Etiqueta corta de la unidad; si el API trae un código desconocido, se muestra tal cual. */
function unitLabel(unit: string): string {
  const known = (UNIT_LABELS as Record<string, string | undefined>)[unit];
  return known ? (known.split(' (')[0] ?? unit) : unit;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
