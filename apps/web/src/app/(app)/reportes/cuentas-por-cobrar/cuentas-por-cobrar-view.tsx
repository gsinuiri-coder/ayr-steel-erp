'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  Role,
  toDecimal,
  type AgingBucket,
  type Decimal,
  type ReceivablesAgingCustomerDto,
  type ReceivablesAgingDto,
  CREDIT_WITHOUT_DUE_LABEL,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { HeaderActions } from '@/components/header-actions';
import { ReportHeader } from '@/components/reports/report-header';
import {
  BusyRegion,
  DETAIL_ROW_CLASSNAME,
  ReportTable,
  type ReportColumn,
} from '@/components/reports/report-table';
import { api } from '@/lib/api';
import { formatAmount, formatDate, formatMoney } from '@/lib/format';
import { agingTotalsOf, allRows } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME, cn } from '@/lib/utils';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
 *
 * cc32 (corte 2): con la plantilla de reportes —«Cómo se calcula», tabla con orden, búsqueda,
 * detalle con chevron y total al pie—. Sigue «a hoy», sin selector de periodo. Lo que se le pide
 * al API no cambia.
 */
export function CuentasPorCobrarView() {
  // D-423: el vendedor va en la URL, como los filtros de D-289; vacío es «todos».
  const [url, setUrl] = useUrlState({ vendedor: '', search: '' });
  const sellerId = UUID.test(url.vendedor) ? url.vendedor : '';
  const [sort, toggleSort] = useSort<string>();
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

  // Un valor que no es un id (escrito a mano) cae a «todos» y se corrige la URL.
  useEffect(() => {
    if (url.vendedor !== '' && sellerId === '') setUrl({ vendedor: '' });
  }, [url.vendedor, sellerId, setUrl]);

  // «A hoy», sin periodo: el alcance es el reporte y el vendedor, y es toda la clave. Al cambiar
  // de vendedor no se muestran las cifras del anterior (serían las de otro con el nombre de este):
  // se espera con el esqueleto, como en el cambio de pestaña de los demás (`keepPreviousInScope`).
  const scope = ['report', 'receivables-aging', sellerId || 'todos'];
  const report = useQuery({
    queryKey: scope,
    placeholderData: keepPreviousInScope<ReceivablesAgingDto>(scope),
    queryFn: () =>
      api<ReceivablesAgingDto>(
        `/reports/receivables-aging${sellerId ? `?sellerId=${sellerId}` : ''}`,
      ),
  });
  const data = report.data;
  const updating = report.isPlaceholderData;
  // Los vendedores de la última respuesta: al cambiar de vendedor las cifras no se conservan,
  // pero el selector sigue pintando el nombre elegido mientras carga.
  const [lastSellers, setLastSellers] = useState<ReceivablesAgingDto['sellers']>([]);
  useEffect(() => {
    if (data) setLastSellers(data.sellers);
  }, [data]);
  const sellers = data?.sellers ?? lastSellers;
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

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <ReportHeader
        title="Cuentas por cobrar"
        subtitle={`Saldo a hoy${data ? ` (${formatDate(data.asOf)})` : ''} por cliente y antigüedad, en soles con IGV.`}
        howItWorks={
          <>
            <p>
              Saldo a hoy de los comprobantes con deuda, por cliente y por antigüedad desde el
              vencimiento. El contado vence el día de su emisión (Cobranzas no lo cuenta como
              vencido; el saldo es el mismo). Importes en soles, con IGV.
            </p>
            <p>
              El saldo es el de Cobranzas, leído igual: el total de este reporte es el de sus
              tarjetas. Abre un cliente con la flecha para ver sus comprobantes.
            </p>
            <p>
              El total al pie suma los clientes de la tabla (con la búsqueda aplicada), con los
              valores completos y redondeado al final.
            </p>
          </>
        }
        actions={
          // cc25 (M3): descarga directa contra el API (patrón D-149), con el mismo vendedor.
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
        }
      />

      {report.isPending && <Skeleton className="h-14 w-full" />}
      {data && (
        <BusyRegion busy={updating}>
          <StatStrip className="sm:grid-cols-3 lg:grid-cols-6" data-testid="cifras-cxc">
            <Stat
              label="Saldo total"
              hint={`${plural(data.totals.customerCount, 'cliente', 'clientes')} · ${plural(data.totals.documentCount, 'comprobante', 'comprobantes')}`}
            >
              {formatMoney(data.totals.balancePen)}
            </Stat>
            {AGING_BUCKETS.map((b) => (
              <Stat
                key={b}
                label={AGING_BUCKET_LABELS[b]}
                hint={b === 'CURRENT' ? undefined : 'vencido'}
              >
                {formatMoney(data.totals.buckets[b])}
              </Stat>
            ))}
          </StatStrip>
        </BusyRegion>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={sellerId || ALL}
          onValueChange={(v) => {
            setUrl({ vendedor: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="h-8 w-56" aria-label="Vendedor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los vendedores</SelectItem>
            {sellers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          aria-label="Buscar en el reporte"
          placeholder="Buscar cliente, RUC, comprobante o pedido"
          className="h-8 max-w-xs"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
      </div>

      <ReportTable
        testId="tabla-cxc"
        rowTestId="cxc-cliente"
        columns={columns(data)}
        rows={data?.customers ?? []}
        rowKey={(c) => c.customerId}
        sort={sort}
        onSort={toggleSort}
        search={searchText}
        updating={updating}
        detail={(c) => <DocumentRows customer={c} />}
        detailLabel={(c) => c.customerName}
        footerLabel={({ length: n }) => `Total · ${plural(n, 'cliente', 'clientes')}`}
        query={{
          isPending: report.isPending,
          isError: report.isError,
          isSuccess: data !== undefined,
          refetch: report.refetch,
        }}
        emptyTitle={
          sellerId
            ? 'Este vendedor no tiene comprobantes con saldo'
            : 'No hay comprobantes con saldo'
        }
        noResultsTitle={`Ningún cliente coincide con «${searchText.trim()}»`}
        onClearSearch={() => {
          setSearchText('');
        }}
        errorTitle="No se pudo cargar el reporte"
      />
    </RoleGate>
  );
}

function columns(
  data: ReceivablesAgingDto | undefined,
): ReportColumn<ReceivablesAgingCustomerDto>[] {
  // Sin búsqueda, el total del API; con búsqueda, el de los clientes a la vista.
  const total = (rows: readonly ReceivablesAgingCustomerDto[]) => {
    if (data && allRows(rows, data.customers)) {
      const t = data.totals;
      return {
        documentCount: t.documentCount,
        balancePen: toDecimal(t.balancePen),
        buckets: Object.fromEntries(
          AGING_BUCKETS.map((b) => [b, toDecimal(t.buckets[b])]),
        ) as Record<AgingBucket, Decimal>,
      };
    }
    return agingTotalsOf(rows);
  };
  return [
    {
      key: 'customer',
      header: 'Cliente',
      // Sin página de detalle de cliente en la app: el nombre no es enlace (se anota en el informe).
      cell: (c) => (
        <span>
          <span className="font-medium">{c.customerName}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {c.customerDocNumber}
          </span>
        </span>
      ),
      sortValue: { text: (c) => c.customerName },
      searchText: (c) => [
        c.customerName,
        c.customerDocNumber,
        ...c.documents.flatMap((d) => [d.number ?? '', d.salesOrderCode ?? '', d.sellerName ?? '']),
      ],
    },
    {
      key: 'documents',
      header: 'Comprobantes',
      align: 'right',
      cell: (c) => String(c.documentCount),
      sortValue: { decimal: (c) => String(c.documentCount) },
      total: (rows) => String(total(rows).documentCount),
    },
    ...AGING_BUCKETS.map((b): ReportColumn<ReceivablesAgingCustomerDto> => ({
      key: BUCKET_KEYS[b],
      header: `${AGING_BUCKET_LABELS[b]} (S/)`,
      align: 'right',
      cell: (c) => formatAmount(c.buckets[b]),
      sortValue: { decimal: (c) => c.buckets[b] },
      total: (rows) => formatAmount(total(rows).buckets[b]),
    })),
    {
      key: 'balance',
      header: 'Saldo (S/)',
      align: 'right',
      cell: (c) => <span className="font-medium">{formatAmount(c.balancePen)}</span>,
      sortValue: { decimal: (c) => c.balancePen },
      total: (rows) => <span data-testid="cxc-total">{formatAmount(total(rows).balancePen)}</span>,
    },
  ];
}

/** Los comprobantes del cliente, del más vencido al que vence más tarde. */
function DocumentRows({ customer }: { customer: ReceivablesAgingCustomerDto }) {
  return (
    <TableRow className={DETAIL_ROW_CLASSNAME}>
      <TableCell colSpan={COLUMN_COUNT} className="p-0 pl-6">
        <Table aria-label={`Comprobantes de ${customer.customerName}`}>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead>Comprobante</TableHead>
              <TableHead>Pedido</TableHead>
              <TableHead>Vendedor</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Vence</TableHead>
              <TableHead className="text-right">Días vencido</TableHead>
              <TableHead className="text-right">Total (S/)</TableHead>
              <TableHead className="text-right">Cobrado (S/)</TableHead>
              <TableHead className="text-right">Notas de crédito (S/)</TableHead>
              <TableHead className="text-right">Saldo (S/)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customer.documents.map((d) => (
              <TableRow key={d.id} className="text-xs" data-testid="cxc-comprobante">
                <TableCell>
                  <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/comprobantes/${d.id}`}>
                    {d.number ?? '—'}
                  </Link>
                  <span className="ml-2 text-muted-foreground">
                    {FISCAL_DOC_TYPE_LABELS[d.docType]}
                  </span>
                </TableCell>
                <TableCell>
                  {d.salesOrderId && d.salesOrderCode ? (
                    <Link
                      className={cn(LINK_CLASSNAME, 'font-mono')}
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
                    d.paymentTerms === 'CREDITO' ? (
                      <span title="A crédito sin fecha de vencimiento: se mide desde su emisión">
                        {CREDIT_WITHOUT_DUE_LABEL}
                      </span>
                    ) : (
                      <span title="Al contado vence el día de su emisión">Contado</span>
                    )
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
                <TableCell className="text-right">{formatAmount(d.totalPen)}</TableCell>
                <TableCell className="text-right">{formatAmount(d.paidPen)}</TableCell>
                <TableCell className="text-right">{formatAmount(d.creditedPen)}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatAmount(d.balancePen)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCell>
    </TableRow>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Claves de columna (en la URL al ordenar) de cada tramo. */
const BUCKET_KEYS: Record<AgingBucket, string> = {
  CURRENT: 'current',
  D1_30: 'd1-30',
  D31_60: 'd31-60',
  D61_90: 'd61-90',
  OVER_90: 'over-90',
};

/** Cliente, comprobantes, los cinco tramos y el saldo. */
const COLUMN_COUNT = 3 + AGING_BUCKETS.length;

const ALL = '__todos__';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
