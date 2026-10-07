'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  Role,
  type ReceivablesAgingCustomerDto,
  type ReceivablesAgingDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { HeaderActions } from '@/components/header-actions';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME } from '@/lib/utils';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * cc25 (D-421..D-423, D-428). Cuentas por cobrar por antigüedad. **Solo administrador** (D-426).
 *
 * Por cliente y sin pestañas de línea: el cobro es por comprobante y un comprobante mezcla
 * líneas (D-421). El saldo es el de /cobranzas, leído igual: el total de acá es el de sus
 * tarjetas. Cada cliente se abre en sus comprobantes, con enlace al comprobante y al pedido.
 */
export function CuentasPorCobrarView() {
  // D-423: el vendedor va en la URL, como los filtros de D-289; vacío es «todos».
  const [url, setUrl] = useUrlState({ vendedor: '' });
  const sellerId = UUID.test(url.vendedor) ? url.vendedor : '';
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  // Un valor que no es un id (escrito a mano) cae a «todos» y se corrige la URL.
  useEffect(() => {
    if (url.vendedor !== '' && sellerId === '') setUrl({ vendedor: '' });
  }, [url.vendedor, sellerId, setUrl]);

  const report = useQuery({
    queryKey: ['report', 'receivables-aging', sellerId || 'todos'],
    // Al cambiar de vendedor, el selector y las cifras siguen a la vista hasta que llega el nuevo.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api<ReceivablesAgingDto>(
        `/reports/receivables-aging${sellerId ? `?sellerId=${sellerId}` : ''}`,
      ),
  });
  const data = report.data;
  // Un vendedor que ya no tiene saldo no está entre las opciones: se vuelve a «todos» para que el
  // selector no quede en blanco.
  const unknownSeller =
    sellerId !== '' &&
    data !== undefined &&
    !report.isPlaceholderData &&
    !data.sellers.some((s) => s.id === sellerId);
  useEffect(() => {
    if (unknownSeller) setUrl({ vendedor: '' });
  }, [unknownSeller, setUrl]);

  const toggle = (customerId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Cuentas por cobrar</h1>
          <p className="text-xs text-muted-foreground">
            Saldo a hoy{data ? ` (${formatDate(data.asOf)})` : ''} de los comprobantes con deuda,
            por cliente y por antigüedad desde el vencimiento. El contado vence el día de su emisión
            (Cobranzas no lo cuenta como vencido; el saldo es el mismo). Importes en soles, con IGV.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Vendedor</span>
            <Select
              value={sellerId || ALL}
              onValueChange={(v) => {
                setUrl({ vendedor: v === ALL ? '' : v });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Vendedor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los vendedores</SelectItem>
                {data?.sellers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {/* cc25 (M3): descarga directa contra el API (patrón D-149), con el mismo vendedor. */}
          <HeaderActions
            primary={['xlsx']}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: `/api/reports/receivables-aging/xlsx${sellerId ? `?sellerId=${sellerId}` : ''}`,
              },
            ]}
          />
        </div>
      </div>

      {data && (
        <StatStrip className="sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Saldo total">{formatMoney(data.totals.balancePen)}</Stat>
          {AGING_BUCKETS.map((b) => (
            <Stat key={b} label={AGING_BUCKET_LABELS[b]}>
              {formatMoney(data.totals.buckets[b])}
            </Stat>
          ))}
        </StatStrip>
      )}

      {report.isPending && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {data && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            Por cliente ({data.totals.customerCount}{' '}
            {data.totals.customerCount === 1 ? 'cliente' : 'clientes'}, {data.totals.documentCount}{' '}
            {data.totals.documentCount === 1 ? 'comprobante' : 'comprobantes'})
          </h2>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="text-right">Comprob.</TableHead>
                  {AGING_BUCKETS.map((b) => (
                    <TableHead key={b} className="text-right">
                      {AGING_BUCKET_LABELS[b]}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                      {sellerId
                        ? 'Este vendedor no tiene comprobantes con saldo.'
                        : 'No hay comprobantes con saldo.'}
                    </TableCell>
                  </TableRow>
                )}
                {data.customers.map((c) => (
                  <CustomerRows
                    key={c.customerId}
                    customer={c}
                    open={open.has(c.customerId)}
                    onToggle={() => {
                      toggle(c.customerId);
                    }}
                  />
                ))}
              </TableBody>
              {data.customers.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">{data.totals.documentCount}</TableCell>
                    {AGING_BUCKETS.map((b) => (
                      <TableCell key={b} className="text-right">
                        {formatMoney(data.totals.buckets[b])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-semibold" data-testid="cxc-total">
                      {formatMoney(data.totals.balancePen)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        </section>
      )}
    </RoleGate>
  );
}

/** La fila del cliente y, abierta, el detalle de sus comprobantes debajo. */
function CustomerRows({
  customer,
  open,
  onToggle,
}: {
  customer: ReceivablesAgingCustomerDto;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow data-testid="cxc-cliente">
        <TableCell>
          <button
            type="button"
            className="flex items-center gap-1 text-left"
            onClick={onToggle}
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="size-4 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="size-4 shrink-0" aria-hidden />
            )}
            <span>
              <span className="font-medium">{customer.customerName}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {customer.customerDocNumber}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell className="text-right">{customer.documentCount}</TableCell>
        {AGING_BUCKETS.map((b) => (
          <TableCell key={b} className="text-right">
            {customer.buckets[b] === ZERO ? '—' : formatMoney(customer.buckets[b])}
          </TableCell>
        ))}
        <TableCell className="text-right font-medium">{formatMoney(customer.balancePen)}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="p-0">
            <Table aria-label={`Comprobantes de ${customer.customerName}`}>
              <TableHeader>
                <TableRow className="text-xs">
                  <TableHead className="pl-8">Comprobante</TableHead>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Vendedor</TableHead>
                  <TableHead>Emisión</TableHead>
                  <TableHead>Vence</TableHead>
                  <TableHead className="text-right">Días vencido</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Cobrado</TableHead>
                  <TableHead className="text-right">Notas de crédito</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customer.documents.map((d) => (
                  <TableRow key={d.id} className="text-xs" data-testid="cxc-comprobante">
                    <TableCell className="pl-8">
                      <Link
                        className={`${LINK_CLASSNAME} font-mono`}
                        href={`/comprobantes/${d.id}`}
                      >
                        {d.number ?? '—'}
                      </Link>
                      <span className="ml-2 text-muted-foreground">
                        {FISCAL_DOC_TYPE_LABELS[d.docType]}
                      </span>
                    </TableCell>
                    <TableCell>
                      {d.salesOrderId && d.salesOrderCode ? (
                        <Link
                          className={`${LINK_CLASSNAME} font-mono`}
                          href={`/pedidos/${d.salesOrderId}`}
                        >
                          {d.salesOrderCode}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Sin pedido</span>
                      )}
                    </TableCell>
                    <TableCell>{d.sellerName ?? '—'}</TableCell>
                    <TableCell>{formatDate(d.issueDate)}</TableCell>
                    <TableCell>
                      {d.dueDate === null ? (
                        <span title="Al contado vence el día de su emisión">Contado</span>
                      ) : (
                        formatDate(d.dueDate)
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.daysOverdue > 0 ? (
                        <Badge variant={d.daysOverdue > 90 ? 'destructive' : 'warning'}>
                          {d.daysOverdue}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">Por vencer</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(d.totalPen)}</TableCell>
                    <TableCell className="text-right">{formatMoney(d.paidPen)}</TableCell>
                    <TableCell className="text-right">{formatMoney(d.creditedPen)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(d.balancePen)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Cliente, comprobantes, los cinco tramos y el saldo. */
const COLUMNS = 3 + AGING_BUCKETS.length;

const ALL = '__todos__';
const ZERO = '0.0000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
