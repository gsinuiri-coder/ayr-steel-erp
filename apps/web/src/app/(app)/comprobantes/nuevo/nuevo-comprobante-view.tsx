'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FISCAL_DOC_TYPE_LABELS,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  INVOICE_DOC_TYPES,
  PAYMENT_TERMS,
  PAYMENT_TERMS_LABELS,
  Role,
  businessToday,
  salesTotals,
  toDecimal,
  type CustomerDto,
  type FiscalDocType,
  type FiscalDocumentDto,
  type PaymentTerms,
  type SalesOrderListItemDto,
  type SalesOrderProgressDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatMoney, unitSymbol } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;
const NONE = 'NONE';

/**
 * RF-70: emisión de un comprobante.
 *
 * Dos caminos en un solo formulario: **desde un pedido** —las líneas salen del pedido y
 * solo se elige cuánto facturar de cada una, que es lo que hace posible la facturación
 * parcial (D-074)— o **venta directa**, con líneas escritas a mano.
 *
 * El total se calcula acá con `salesTotals` de `@ayr/shared`, la misma función que usa el
 * API: el número que el vendedor ve mientras tipea es exactamente el que se va a guardar,
 * igual que en la cotización (D-068).
 */
export function NuevoComprobanteView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const [docType, setDocType] = useState<FiscalDocType>('FACTURA');
  const [customerId, setCustomerId] = useState<string>('');
  const [salesOrderId, setSalesOrderId] = useState<string>(searchParams.get('pedido') ?? NONE);
  const [issueDate, setIssueDate] = useState(businessToday());
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>('CONTADO');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [forceGeneric, setForceGeneric] = useState(false);
  /** Cantidad a facturar por línea del pedido; vacío = no se factura esa línea. */
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});
  /** Líneas libres de una venta directa. */
  const [freeLines, setFreeLines] = useState<
    { description: string; qty: string; unit: string; unitPricePen: string }[]
  >([{ description: '', qty: '', unit: 'NIU', unitPricePen: '' }]);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api<CustomerDto[]>('/customers'),
  });

  const orders = useQuery({
    queryKey: ['sales-orders', 'invoiceable'],
    queryFn: () => api<SalesOrderListItemDto[]>('/sales/orders'),
  });

  const progress = useQuery({
    queryKey: ['order-progress', salesOrderId],
    queryFn: () => api<SalesOrderProgressDto>(`/invoicing/orders/${salesOrderId}/progress`),
    enabled: salesOrderId !== NONE,
  });

  // Elegir el pedido fija el cliente: facturar a otro sería emitirle a alguien que no
  // compró. El API lo rechaza igual; acá se evita el viaje.
  useEffect(() => {
    if (salesOrderId === NONE) return;
    const order = orders.data?.find((o) => o.id === salesOrderId);
    if (order) setCustomerId(order.customerId);
  }, [salesOrderId, orders.data]);

  // Al cargar el avance, se propone facturar todo lo pendiente de cada línea: es el caso
  // normal, y dejarlo en blanco obligaba a retipear el pedido entero.
  useEffect(() => {
    if (!progress.data) return;
    setQtyByLine(
      Object.fromEntries(
        progress.data.lines
          .filter((l) => Number(l.pendingInvoiceQty) > 0)
          .map((l) => [l.salesOrderItemId, l.pendingInvoiceQty]),
      ),
    );
  }, [progress.data]);

  const customer = customers.data?.find((c) => c.id === customerId);
  const activeCustomers = (customers.data ?? []).filter((c) => c.isActive);

  const lines = useMemo(() => {
    if (salesOrderId !== NONE) {
      return (progress.data?.lines ?? [])
        .filter((l) => (qtyByLine[l.salesOrderItemId] ?? '').trim() !== '')
        .map((l) => ({
          qty: qtyByLine[l.salesOrderItemId] ?? '0',
          unitPricePen: l.unitPricePen,
        }));
    }
    return freeLines
      .filter((l) => l.qty.trim() !== '' && l.unitPricePen.trim() !== '')
      .map((l) => ({ qty: l.qty, unitPricePen: l.unitPricePen }));
  }, [salesOrderId, progress.data, qtyByLine, freeLines]);

  const totals = lines.length > 0 ? salesTotals(lines) : null;
  const isGenericCustomer = customer?.isSystem ?? false;
  const overGenericCap =
    isGenericCustomer && totals?.total.gt(toDecimal(GENERIC_CUSTOMER_MAX_TOTAL_PEN)) === true;

  const create = useMutation({
    mutationFn: () => {
      const items =
        salesOrderId !== NONE
          ? (progress.data?.lines ?? [])
              .filter((l) => (qtyByLine[l.salesOrderItemId] ?? '').trim() !== '')
              .map((l) => ({
                salesOrderItemId: l.salesOrderItemId,
                qty: (qtyByLine[l.salesOrderItemId] ?? '').trim(),
              }))
          : freeLines
              .filter((l) => l.qty.trim() !== '' && l.unitPricePen.trim() !== '')
              .map((l) => ({
                description: l.description.trim(),
                qty: l.qty.trim(),
                unit: l.unit,
                unitPricePen: l.unitPricePen.trim(),
              }));

      return api<FiscalDocumentDto>('/invoicing/documents', {
        method: 'POST',
        body: {
          docType,
          customerId,
          ...(salesOrderId !== NONE ? { salesOrderId } : {}),
          issueDate,
          paymentTerms,
          ...(paymentTerms === 'CREDITO' && dueDate ? { dueDate } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          forceGenericCustomer: forceGeneric,
          items,
        },
      });
    },
    onSuccess: (created) => {
      toast.success('Borrador creado: revísalo y emítelo');
      invalidateInvoicing(queryClient, {
        orderId: salesOrderId === NONE ? undefined : salesOrderId,
      });
      router.push(`/comprobantes/${created.id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el comprobante');
    },
  });

  const canSubmit = customerId !== '' && lines.length > 0 && !create.isPending;

  return (
    <RoleGate allow={SALES_ROLES}>
      <div>
        <h1 className="text-2xl font-semibold">Nuevo comprobante</h1>
        <p className="text-sm text-muted-foreground">
          Se crea como borrador. El correlativo se toma recién al emitirlo, así que un borrador
          abandonado no deja hueco en la numeración.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Datos del comprobante</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>Tipo</Label>
            <Select
              value={docType}
              onValueChange={(v) => {
                setDocType(v as FiscalDocType);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVOICE_DOC_TYPES.filter((t) => t !== 'NOTA_CREDITO').map((t) => (
                  <SelectItem key={t} value={t}>
                    {FISCAL_DOC_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Pedido</Label>
            <Select value={salesOrderId} onValueChange={setSalesOrderId}>
              <SelectTrigger>
                <SelectValue placeholder="Venta directa" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Venta directa (sin pedido)</SelectItem>
                {(orders.data ?? [])
                  .filter((o) => o.status !== 'CANCELLED')
                  .map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.code} · {o.customerName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Cliente</Label>
            <Select
              value={customerId}
              onValueChange={setCustomerId}
              disabled={salesOrderId !== NONE}
            >
              <SelectTrigger>
                <SelectValue placeholder="Elige un cliente" />
              </SelectTrigger>
              <SelectContent>
                {activeCustomers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.docNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Fecha de emisión</Label>
            <Input
              type="date"
              value={issueDate}
              onChange={(e) => {
                setIssueDate(e.target.value);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>Condición de pago</Label>
            <Select
              value={paymentTerms}
              onValueChange={(v) => {
                setPaymentTerms(v as PaymentTerms);
                if (v === 'CONTADO') setDueDate('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PAYMENT_TERMS_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Vencimiento</Label>
            <Input
              type="date"
              value={dueDate}
              disabled={paymentTerms === 'CONTADO'}
              onChange={(e) => {
                setDueDate(e.target.value);
              }}
            />
            {paymentTerms === 'CREDITO' && !dueDate && (
              <p className="text-xs text-muted-foreground">
                Sin fecha, se calcula con los días de crédito del cliente
                {customer ? ` (${customer.creditDays})` : ''}.
              </p>
            )}
          </div>

          <div className="space-y-2 md:col-span-3">
            <Label>Observaciones</Label>
            <Input
              value={notes}
              maxLength={500}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* D-077: el tope de la boleta genérica, dicho antes de mandar y no como error del API. */}
      {isGenericCustomer && docType !== 'BOLETA' && (
        <Alert variant="destructive">
          <AlertDescription>
            Al cliente «público en general» solo se le emiten boletas. Para una factura, elige un
            cliente con RUC.
          </AlertDescription>
        </Alert>
      )}
      {overGenericCap && (
        <Alert variant={forceGeneric ? 'default' : 'destructive'}>
          <AlertDescription className="space-y-2">
            <p>
              Una boleta a «público en general» no puede pasar de{' '}
              {formatMoney(GENERIC_CUSTOMER_MAX_TOTAL_PEN)} y esta suma{' '}
              {formatMoney(totals?.total.toFixed(4) ?? '0')}. Lo correcto es identificar al cliente.
            </p>
            {isAdmin && (
              <Button
                variant={forceGeneric ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => {
                  setForceGeneric((v) => !v);
                }}
              >
                {forceGeneric
                  ? 'Excepción activada: quedará registrada a tu nombre'
                  : 'Emitir igual (queda registrado)'}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {salesOrderId !== NONE ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Líneas del pedido</h2>
          <p className="text-sm text-muted-foreground">
            Se propone facturar todo lo pendiente. Baja la cantidad para facturar en partes; deja
            una línea en blanco para no incluirla.
          </p>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead className="text-right">Pedido</TableHead>
                  <TableHead className="text-right">Ya facturado</TableHead>
                  <TableHead className="text-right">Pendiente</TableHead>
                  <TableHead className="text-right">P. unitario</TableHead>
                  <TableHead className="w-36 text-right">A facturar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(progress.data?.lines ?? []).map((l) => (
                  <TableRow key={l.salesOrderItemId}>
                    <TableCell>
                      <div className="font-medium">{l.productSku}</div>
                      <div className="text-xs text-muted-foreground">{l.description}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      {l.qty} {unitSymbol(l.unit)}
                    </TableCell>
                    <TableCell className="text-right">{l.invoicedQty}</TableCell>
                    <TableCell className="text-right">{l.pendingInvoiceQty}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(l.unitPricePen, 'PEN', 4)}
                    </TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        className="text-right"
                        disabled={Number(l.pendingInvoiceQty) <= 0}
                        value={qtyByLine[l.salesOrderItemId] ?? ''}
                        onChange={(e) => {
                          setQtyByLine((prev) => ({
                            ...prev,
                            [l.salesOrderItemId]: e.target.value,
                          }));
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {(progress.data?.lines.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Elige un pedido para ver sus líneas.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Líneas</h2>
          <div className="space-y-2">
            {freeLines.map((line, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="min-w-64 flex-1 space-y-1">
                  <Label className="text-xs">Descripción</Label>
                  <Input
                    value={line.description}
                    maxLength={240}
                    onChange={(e) => {
                      setFreeLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)),
                      );
                    }}
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label className="text-xs">Cantidad</Label>
                  <Input
                    inputMode="decimal"
                    value={line.qty}
                    onChange={(e) => {
                      setFreeLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, qty: e.target.value } : l)),
                      );
                    }}
                  />
                </div>
                <div className="w-24 space-y-1">
                  <Label className="text-xs">Unidad</Label>
                  <Input
                    value={line.unit}
                    maxLength={20}
                    onChange={(e) => {
                      setFreeLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, unit: e.target.value } : l)),
                      );
                    }}
                  />
                </div>
                <div className="w-36 space-y-1">
                  <Label className="text-xs">P. unitario sin IGV</Label>
                  <Input
                    inputMode="decimal"
                    value={line.unitPricePen}
                    onChange={(e) => {
                      setFreeLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, unitPricePen: e.target.value } : l)),
                      );
                    }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={freeLines.length === 1}
                  onClick={() => {
                    setFreeLines((prev) => prev.filter((_, j) => j !== i));
                  }}
                >
                  Quitar
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFreeLines((prev) => [
                ...prev,
                { description: '', qty: '', unit: 'NIU', unitPricePen: '' },
              ]);
            }}
          >
            Agregar línea
          </Button>
        </section>
      )}

      {totals && (
        <div className="flex justify-end gap-6 text-sm">
          <span>Subtotal {formatMoney(totals.subtotal.toFixed(4))}</span>
          <span>IGV {formatMoney(totals.igv.toFixed(4))}</span>
          <span className="font-semibold">Total {formatMoney(totals.total.toFixed(4))}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button
          disabled={!canSubmit}
          onClick={() => {
            create.mutate();
          }}
        >
          Crear borrador
        </Button>
      </div>
    </RoleGate>
  );
}
