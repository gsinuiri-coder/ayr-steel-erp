'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
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
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatQty, isPositiveDecimal, todayIso } from '@/lib/format';
import { ReasonDialog } from '@/components/reason-dialog';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
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
import { Input } from '@/components/ui/input';
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
  };

  const receive = useMutation({
    mutationFn: () => api<PurchaseDto>(`/purchases/${id}/receive`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Compra recibida: el stock ya está en el kardex');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo recibir'),
  });

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<PurchaseDto>(`/purchases/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Compra anulada');
      setConfirmCancel(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo anular'),
  });

  if (purchase.isPending) return <Skeleton className="h-64 w-full" />;
  if (purchase.isError || !purchase.data) {
    return <p className="text-destructive">No se pudo cargar la compra.</p>;
  }

  const p = purchase.data;
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const canReceive = user.role === Role.ADMINISTRADOR || user.role === Role.SUPERVISOR_PLANTA;
  const hasBalance = isPositiveDecimal(p.balance);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {PURCHASE_DOC_TYPE_LABELS[p.docType]} {p.documentLabel}
          </h1>
          <p className="text-sm text-muted-foreground">
            {p.supplierCode} — {p.supplierName} · {PURCHASE_TYPE_LABELS[p.type]} ·{' '}
            {BUSINESS_LINE_LABELS[p.businessLine]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={p.status === 'RECEIVED' ? 'secondary' : 'outline'}>
            {PURCHASE_STATUS_LABELS[p.status]}
          </Badge>
          {canReceive && p.status === 'DRAFT' && (
            <Button
              disabled={receive.isPending}
              onClick={() => {
                receive.mutate();
              }}
            >
              {receive.isPending ? 'Recibiendo…' : 'Recibir'}
            </Button>
          )}
          {isAdmin && p.status !== 'CANCELLED' && (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Anular
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comprobante</CardTitle>
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
                  <Link
                    className="underline underline-offset-4"
                    href={`/compras/${p.relatedPurchaseId}`}
                  >
                    {p.relatedPurchaseLabel}
                  </Link>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Importes</CardTitle>
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
            <CardTitle className="text-base">Cuenta por pagar</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Pagado" value={formatMoney(p.paidAmount, p.currency)} />
            <Row label="Saldo" value={formatMoney(p.balance, p.currency)} />
            {isAdmin && hasBalance && p.status !== 'CANCELLED' && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-fit"
                onClick={() => {
                  setShowPaymentForm((v) => !v);
                }}
              >
                Registrar pago
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {showPaymentForm && (
        <PaymentForm
          purchaseId={p.id}
          currency={p.currency}
          balance={p.balance}
          onSaved={() => {
            setShowPaymentForm(false);
            invalidate();
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {p.type === PurchaseType.COIL ? 'Bobinas' : 'Detalle'}
          </CardTitle>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.items.map((item) => (
                <TableRow key={item.id}>
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
                    {formatMoney(item.unitPrice, p.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.subtotal, p.currency)}
                  </TableCell>
                  {p.type === PurchaseType.COIL && (
                    <TableCell className="font-mono text-xs">{item.coilCode ?? '—'}</TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {p.landedCostServices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Servicios imputados al costo de las bobinas (D-043)
            </CardTitle>
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
                      <Link
                        className="underline underline-offset-4"
                        href={`/compras/${service.purchaseId}`}
                      >
                        {service.documentLabel}
                      </Link>
                    </TableCell>
                    <TableCell>{SERVICE_KIND_LABELS[service.serviceKind]}</TableCell>
                    <TableCell>
                      <Badge variant={service.status === 'RECEIVED' ? 'secondary' : 'outline'}>
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
          <CardTitle className="text-base">Pagos</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Medio</TableHead>
                <TableHead>Referencia</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>{formatDate(payment.date)}</TableCell>
                  <TableCell>{PAYMENT_METHOD_LABELS[payment.method]}</TableCell>
                  <TableCell>{payment.reference ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(payment.amount, payment.currency)}
                  </TableCell>
                </TableRow>
              ))}
              {p.payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
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

      <ReasonDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Anular la compra ${p.documentLabel}`}
        description={
          p.status === 'RECEIVED'
            ? 'Se revierten todos los movimientos de kardex de la compra y sus bobinas quedan anuladas. Solo se puede si nada de lo que entró con ella se movió después.'
            : 'La compra queda anulada de forma permanente. No se puede deshacer.'
        }
        confirmLabel="Sí, anular"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          // El diálogo se cierra en `onSuccess`: si el API rechaza la anulación —lo hace
          // cuando algo se movió después—, el motivo escrito no se pierde.
          cancel.mutate(reason);
        }}
      />
    </>
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
  onSaved,
}: {
  purchaseId: string;
  currency: Currency;
  balance: string;
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

  const addPayment = useMutation({
    mutationFn: (values: PaymentValues) =>
      api<PurchaseDto>(`/purchases/${purchaseId}/payments`, {
        method: 'POST',
        body: {
          date: values.date,
          amount: values.amount,
          currency: values.currency,
          exchangeRate: values.exchangeRate?.trim() ? values.exchangeRate.trim() : undefined,
          method: values.method,
          reference: values.reference?.trim() ? values.reference.trim() : undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Pago registrado');
      onSaved();
    },
    onError: (err) => {
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'No se pudo registrar el pago',
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Nuevo pago</CardTitle>
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
                  <Select value={field.value} onValueChange={field.onChange}>
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
                      fecha del pago (D-029).
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="md:col-span-5">
              <Button type="submit" disabled={addPayment.isPending}>
                {addPayment.isPending ? 'Guardando…' : 'Guardar pago'}
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
