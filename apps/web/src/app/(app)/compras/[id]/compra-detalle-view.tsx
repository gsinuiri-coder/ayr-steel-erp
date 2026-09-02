'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  CURRENCIES,
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
  type PurchaseDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatQty, todayIso } from '@/lib/format';
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

  const purchase = useQuery({
    queryKey: ['purchase', id],
    queryFn: () => api<PurchaseDto>(`/purchases/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase', id] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
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
    mutationFn: () => api<PurchaseDto>(`/purchases/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Compra anulada');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo anular'),
  });

  const paymentForm = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      date: todayIso(),
      amount: '',
      currency: purchase.data?.currency ?? 'PEN',
      exchangeRate: '',
      method: 'TRANSFER',
      reference: '',
    },
  });

  const addPayment = useMutation({
    mutationFn: (values: PaymentValues) =>
      api<PurchaseDto>(`/purchases/${id}/payments`, {
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
      paymentForm.reset({ ...paymentForm.getValues(), amount: '', reference: '' });
      setShowPaymentForm(false);
      invalidate();
    },
    onError: (err) => {
      paymentForm.setError('root', {
        message: err instanceof ApiError ? err.message : 'No se pudo registrar el pago',
      });
    },
  });

  if (purchase.isPending) return <Skeleton className="h-64 w-full" />;
  if (purchase.isError || !purchase.data) {
    return <p className="text-destructive">No se pudo cargar la compra.</p>;
  }

  const p = purchase.data;
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const canReceive = user.role === Role.ADMINISTRADOR || user.role === Role.SUPERVISOR_PLANTA;
  const hasBalance = Number.parseFloat(p.balance) > 0;

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
          {isAdmin && p.status === 'DRAFT' && (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => {
                cancel.mutate();
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
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nuevo pago</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...paymentForm}>
              <form
                onSubmit={paymentForm.handleSubmit((v) => {
                  addPayment.mutate(v);
                })}
                className="grid gap-4 md:grid-cols-5"
                noValidate
              >
                {paymentForm.formState.errors.root && (
                  <p role="alert" className="text-sm text-destructive md:col-span-5">
                    {paymentForm.formState.errors.root.message}
                  </p>
                )}
                <FormField
                  control={paymentForm.control}
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
                  control={paymentForm.control}
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
                  control={paymentForm.control}
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
                  control={paymentForm.control}
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
                  control={paymentForm.control}
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
                <div className="md:col-span-5">
                  <Button type="submit" disabled={addPayment.isPending}>
                    {addPayment.isPending ? 'Guardando…' : 'Guardar pago'}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
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
                  <TableCell className="text-right">{formatQty(item.qty, item.unit)}</TableCell>
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

      <div>
        <Button variant="outline" asChild>
          <Link href={`/proveedores/${p.supplierId}/estado-cuenta`}>
            Ver estado de cuenta del proveedor
          </Link>
        </Button>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
