'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  COIL_REPORT_LINES,
  Role,
  toDecimal,
  type Decimal,
  type ProductionSummaryDto,
  type ProductionSummaryGroupDto,
  type ProductionSummaryLine,
  type ProductionSummaryOrderDto,
} from '@ayr/shared';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { ListStateMessage } from '@/components/list-state';
import { ReportHeader } from '@/components/reports/report-header';
import { PeriodPicker, useReportPeriod } from '@/components/reports/report-period';
import {
  BusyRegion,
  DETAIL_ROW_CLASSNAME,
  ReportTable,
  type ReportColumn,
} from '@/components/reports/report-table';
import { Segmented } from '@/components/reports/segmented';
import { RoleGate } from '@/components/role-gate';
import { Stat, StatStrip } from '@/components/stat-strip';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatAmount, formatKg, formatMeters, formatUnits } from '@/lib/format';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { allRows, productionTotalsOf, type ProductionTotals } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME, cn } from '@/lib/utils';

/**
 * cc29 (M2, D-420, D-464, D-468). Reporte de producción: una fila por OP (un producto y una línea
 * del pedido), con lo que cada bobina dio según el kardex y un subtotal por pedido. Administrador y
 * supervisor de planta; los costos los trae el API solo para el administrador. Solo lectura.
 *
 * cc32 (corte 2): con la plantilla de reportes —periodo único en la URL, «Cómo se calcula», tabla
 * con orden, búsqueda, detalle con chevron y total al pie—. El subtotal por pedido, que con el
 * orden por columna ya no puede ir entre las filas, pasa a «Ver por» Pedido. Lo que se le pide al
 * API no cambia.
 */
export function ProduccionView() {
  const periodState = useReportPeriod();
  const { period, valid } = periodState;
  const { tab, select } = useLineTab(LINE_TABS);
  const line = tab as ProductionSummaryLine;
  const [url, setUrl] = useUrlState({ ver: 'orden', search: '' });
  const view: ProductionView = url.ver === 'pedido' ? 'pedido' : 'orden';
  const [sort, toggleSort] = useSort<string>();
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const qs = `from=${period.from}&to=${period.to}&businessLine=${line}`;

  // El alcance es el reporte y su pestaña; el periodo va después (`keepPreviousInScope`).
  const scope = ['report', 'production-summary', line];
  const report = useQuery({
    queryKey: [...scope, period.from, period.to],
    queryFn: () => api<ProductionSummaryDto>(`/reports/production-summary?${qs}`),
    enabled: valid,
    // Al cambiar de periodo, el dato anterior queda a la vista (atenuado) mientras carga.
    placeholderData: keepPreviousInScope<ProductionSummaryDto>(scope),
  });
  const data = valid ? report.data : undefined;
  const updating = valid && report.isPlaceholderData;
  const loading = !periodState.complete || (valid && report.isPending);
  const withCosts = data?.withCosts === true;
  // En Drywall, lo que sale al cerrar la OP es la merma de proceso (D-057), no un despunte.
  const trimLabel = line === BusinessLine.DRYWALL ? 'Merma de proceso' : 'Despunte';
  const orders = data?.groups.flatMap((g) => g.orders) ?? [];
  const unattributed = data !== undefined && !toDecimal(data.totals.unattributedKg).isZero();

  const query = {
    isPending: loading,
    isError: report.isError,
    isSuccess: data !== undefined,
    refetch: report.refetch,
  };
  const clearSearch = () => {
    setSearchText('');
  };
  const emptyTitle = 'No hay producción de esta línea en ese periodo';

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <ReportHeader
        title="Reporte de producción"
        subtitle={`${BUSINESS_LINE_LABELS[line]}. Lo que produjo cada orden en el periodo, con los kilos del kardex.`}
        howItWorks={
          <>
            <p>
              {BUSINESS_LINE_LABELS[line]}. Una fila por orden de producción, con los movimientos de
              kardex del rango por la fecha del reporte de planta. «Ver por» Pedido las agrupa por
              pedido, con su subtotal. El {trimLabel.toLowerCase()} es de la orden; por bobina va
              como lo registró el kardex, repartido en orden de montaje. El ajuste de cierre de una
              bobina no es de ninguna orden: está en «Merma por bobina».
            </p>
            <p data-testid="aviso-estandar">
              El teórico ya incluye el 1 % de merma estándar; el porcentaje es lo que lo pasa. Hasta
              el {data?.standardPct ?? '1.00'} % es normal; más que eso se marca en rojo.
            </p>
            {unattributed && (
              <p data-testid="aviso-sin-reporte">
                {formatKg(data.totals.unattributedKg)} salieron como producción en el rango sin
                apuntar a un reporte de planta: no son de ninguna orden y no están en las filas.
              </p>
            )}
            <p>
              El total al pie suma las filas de la tabla (con la búsqueda aplicada), con los valores
              completos y redondeado al final.
            </p>
          </>
        }
        actions={
          // Descarga directa contra el API (patrón D-149), con el periodo y la pestaña que se ven.
          valid ? (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/production-summary/xlsx?${qs}`,
                },
              ]}
            />
          ) : undefined
        }
      />

      <PeriodPicker state={periodState} updating={updating} />

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {periodState.error !== null && (
        <ListStateMessage tone="error" title={periodState.error} hint="Elige otro periodo." />
      )}

      {periodState.error === null && (
        <>
          {loading && <Skeleton className="h-14 w-full" />}
          {data && (
            <BusyRegion busy={updating}>
              <StatStrip className="sm:grid-cols-3 lg:grid-cols-5" data-testid="cifras-produccion">
                <Stat label="Órdenes">{data.totals.orderCount}</Stat>
                <Stat label="Teórico (kg)">{formatKg(data.totals.theoreticalKg, null)}</Stat>
                <Stat
                  label="Salido (kg)"
                  hint={
                    unattributed
                      ? `más ${formatKg(data.totals.unattributedKg)} sin reporte de planta: no son de ninguna orden ni están en las filas`
                      : undefined
                  }
                >
                  {formatKg(data.totals.consumedKg, null)}
                </Stat>
                <Stat label={`${trimLabel} (kg)`}>{formatKg(data.totals.trimKg, null)}</Stat>
                <Stat label="Merma %" hint={`normal hasta ${data.standardPct} %`}>
                  <Pct value={data.totals.wastePct} over={data.totals.overStandard} />
                </Stat>
              </StatStrip>
            </BusyRegion>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Segmented<ProductionView>
              label="Ver por"
              showLabel
              value={view}
              options={[
                { value: 'orden', label: 'Orden' },
                { value: 'pedido', label: 'Pedido' },
              ]}
              onChange={(v) => {
                setUrl({ ver: v });
              }}
            />
            <Input
              type="search"
              aria-label="Buscar en el reporte"
              placeholder="Buscar orden, pedido, producto o bobina"
              className="h-8 max-w-xs"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
              }}
            />
          </div>

          {view === 'orden' ? (
            <ReportTable
              testId="tabla-produccion"
              rowTestId="produccion-op"
              columns={orderColumns(trimLabel, withCosts, data, orders)}
              rows={orders}
              rowKey={(o) => o.productionOrderId}
              sort={sort}
              onSort={toggleSort}
              search={searchText}
              updating={updating}
              detail={(o) => <CoilRows order={o} withCosts={withCosts} trimLabel={trimLabel} />}
              detailLabel={(o) => o.code}
              footerLabel={({ length: n }) =>
                `Total · ${n === 1 ? '1 orden' : `${String(n)} órdenes`}`
              }
              query={query}
              emptyTitle={emptyTitle}
              noResultsTitle={`Ninguna orden coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          ) : (
            <ReportTable
              testId="tabla-produccion"
              rowTestId="produccion-subtotal"
              columns={groupColumns(trimLabel, withCosts, data)}
              rows={data?.groups ?? []}
              rowKey={(g) => g.salesOrderId ?? 'sin-pedido'}
              sort={sort}
              onSort={toggleSort}
              search={searchText}
              updating={updating}
              detail={(g) => <OrderRows group={g} withCosts={withCosts} />}
              detailLabel={(g) => g.salesOrderCode ?? 'las órdenes a stock'}
              footerLabel={() => 'Total'}
              query={query}
              emptyTitle={emptyTitle}
              noResultsTitle={`Ningún pedido coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          )}
        </>
      )}
    </RoleGate>
  );
}

type ProductionView = 'orden' | 'pedido';

/** Las cifras del API, como `Decimal`, para el pie sin búsqueda. */
function apiTotals(t: ProductionSummaryDto['totals']): ProductionTotals {
  return {
    theoreticalKg: toDecimal(t.theoreticalKg),
    consumedKg: toDecimal(t.consumedKg),
    trimKg: toDecimal(t.trimKg),
    wastePct: t.wastePct,
    overStandard: t.overStandard,
    materialCostPen: t.materialCostPen === null ? null : toDecimal(t.materialCostPen),
    trimCostPen: t.trimCostPen === null ? null : toDecimal(t.trimCostPen),
  };
}

type Figures = Pick<
  ProductionSummaryOrderDto,
  | 'theoreticalKg'
  | 'consumedKg'
  | 'trimKg'
  | 'wastePct'
  | 'overStandard'
  | 'materialCostPen'
  | 'trimCostPen'
>;

/** Las columnas de cifras, iguales para una orden y para un pedido. */
function figureColumns<T>(
  figures: (row: T) => Figures,
  total: (rows: readonly T[]) => ProductionTotals,
  trimLabel: string,
  withCosts: boolean,
): ReportColumn<T>[] {
  const columns: ReportColumn<T>[] = [
    {
      key: 'theoretical',
      header: 'Teórico (kg)',
      align: 'right',
      cell: (r) => formatKg(figures(r).theoreticalKg, null),
      sortValue: { decimal: (r) => figures(r).theoreticalKg },
      total: (rows) => formatKg(total(rows).theoreticalKg, null),
    },
    {
      key: 'consumed',
      header: 'Salido (kg)',
      align: 'right',
      cell: (r) => formatKg(figures(r).consumedKg, null),
      sortValue: { decimal: (r) => figures(r).consumedKg },
      total: (rows) => formatKg(total(rows).consumedKg, null),
    },
    {
      key: 'trim',
      header: `${trimLabel} (kg)`,
      align: 'right',
      cell: (r) => formatKg(figures(r).trimKg, null),
      sortValue: { decimal: (r) => figures(r).trimKg },
      total: (rows) => formatKg(total(rows).trimKg, null),
    },
    {
      key: 'pct',
      header: 'Merma %',
      align: 'right',
      cell: (r) => <Pct value={figures(r).wastePct} over={figures(r).overStandard} />,
      sortValue: { decimal: (r) => figures(r).wastePct ?? '' },
      total: (rows) => {
        const t = total(rows);
        return <Pct value={t.wastePct} over={t.overStandard} />;
      },
    },
  ];
  if (!withCosts) return columns;
  return [
    ...columns,
    {
      key: 'materialCost',
      header: 'Costo salido (S/)',
      align: 'right',
      cell: (r) => amountOrDash(figures(r).materialCostPen),
      sortValue: { decimal: (r) => figures(r).materialCostPen ?? '' },
      total: (rows) => amountOrDash(total(rows).materialCostPen),
    },
    {
      key: 'trimCost',
      header: `Costo ${trimLabel.toLowerCase()} (S/)`,
      align: 'right',
      cell: (r) => amountOrDash(figures(r).trimCostPen),
      sortValue: { decimal: (r) => figures(r).trimCostPen ?? '' },
      total: (rows) => amountOrDash(total(rows).trimCostPen),
    },
  ];
}

function orderColumns(
  trimLabel: string,
  withCosts: boolean,
  data: ProductionSummaryDto | undefined,
  all: readonly ProductionSummaryOrderDto[],
): ReportColumn<ProductionSummaryOrderDto>[] {
  const total = (rows: readonly ProductionSummaryOrderDto[]) =>
    data && allRows(rows, all)
      ? apiTotals(data.totals)
      : productionTotalsOf(rows, data?.standardPct ?? '1.00');
  return [
    {
      key: 'code',
      header: 'Orden',
      cell: (o) => (
        <Link
          className={cn(LINK_CLASSNAME, 'font-mono')}
          href={`/produccion/${o.productionOrderId}`}
        >
          {o.code}
        </Link>
      ),
      sortValue: { text: (o) => o.code },
      searchText: (o) => [o.code, ...o.coils.map((c) => c.code)],
    },
    {
      key: 'order',
      header: 'Pedido',
      cell: (o) => <OrderLine order={o} />,
      sortValue: { text: (o) => o.salesOrderCode ?? '' },
      searchText: (o) => o.salesOrderCode ?? 'A stock',
    },
    {
      key: 'product',
      header: 'Producto',
      cell: (o) => (
        <span className="inline-flex flex-col">
          <span className="font-mono text-xs">{o.productSku}</span>
          <span className="text-xs text-muted-foreground">{o.productName}</span>
        </span>
      ),
      sortValue: { text: (o) => o.productSku },
      searchText: (o) => [o.productSku, o.productName],
    },
    {
      key: 'quantity',
      header: 'Cantidad',
      align: 'right',
      cell: (o) => quantityText(o),
      sortValue: { decimal: (o) => o.quantity },
    },
    ...figureColumns<ProductionSummaryOrderDto>((o) => o, total, trimLabel, withCosts),
  ];
}

function groupColumns(
  trimLabel: string,
  withCosts: boolean,
  data: ProductionSummaryDto | undefined,
): ReportColumn<ProductionSummaryGroupDto>[] {
  const total = (rows: readonly ProductionSummaryGroupDto[]) =>
    data && allRows(rows, data.groups)
      ? apiTotals(data.totals)
      : productionTotalsOf(
          rows.flatMap((g) => g.orders),
          data?.standardPct ?? '1.00',
        );
  return [
    {
      key: 'order',
      header: 'Pedido',
      cell: (g) =>
        g.salesOrderId !== null && g.salesOrderCode !== null ? (
          <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/pedidos/${g.salesOrderId}`}>
            {g.salesOrderCode}
          </Link>
        ) : (
          'Sin pedido (a stock)'
        ),
      sortValue: { text: (g) => g.salesOrderCode ?? '' },
      searchText: (g) => [
        g.salesOrderCode ?? 'Sin pedido (a stock)',
        ...g.orders.flatMap((o) => [o.code, o.productSku, o.productName]),
      ],
    },
    {
      key: 'count',
      header: 'Órdenes',
      align: 'right',
      cell: (g) => String(g.orders.length),
      sortValue: { decimal: (g) => String(g.orders.length) },
      total: (groups) => String(groups.reduce((n, g) => n + g.orders.length, 0)),
    },
    ...figureColumns<ProductionSummaryGroupDto>((g) => g.subtotal, total, trimLabel, withCosts),
  ];
}

/** El pedido y la línea de la orden; una corrida a stock no tiene pedido. */
function OrderLine({ order: o }: { order: ProductionSummaryOrderDto }) {
  if (o.salesOrderId === null || o.salesOrderCode === null) {
    return <span className="text-muted-foreground">A stock</span>;
  }
  return (
    <span>
      <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/pedidos/${o.salesOrderId}`}>
        {o.salesOrderCode}
      </Link>
      {o.lineNumber !== null && (
        <span className="text-muted-foreground"> · línea {String(o.lineNumber)}</span>
      )}
    </span>
  );
}

/** Lo producido: metros (producto en metros) o piezas, en unidades («1,200 und», D-579). */
function quantityText(o: ProductionSummaryOrderDto): string {
  if (o.quantityUnit === 'm') return formatMeters(o.quantity);
  return formatUnits(o.quantity);
}

/** Lo que cada bobina dio a la orden, alineado con las columnas de la orden. */
function CoilRows({
  order,
  withCosts,
  trimLabel,
}: {
  order: ProductionSummaryOrderDto;
  withCosts: boolean;
  trimLabel: string;
}) {
  return (
    <>
      {order.coils.map((c) => (
        <TableRow key={c.coilId} className={DETAIL_ROW_CLASSNAME} data-testid="produccion-bobina">
          <TableCell className="pl-8">
            <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/bobinas/${c.coilId}`}>
              {c.code}
            </Link>
          </TableCell>
          <TableCell colSpan={3} className="text-muted-foreground">
            {!toDecimal(c.trimKg).isZero() &&
              `${trimLabel} de la orden repartido en orden de montaje`}
          </TableCell>
          <TableCell />
          <TableCell className="text-right">{formatKg(c.consumedKg, null)}</TableCell>
          <TableCell className="text-right">{formatKg(c.trimKg, null)}</TableCell>
          <TableCell />
          {withCosts && <TableCell colSpan={2} />}
        </TableRow>
      ))}
    </>
  );
}

/** Las órdenes de un pedido, alineadas con las columnas del pedido. */
function OrderRows({ group, withCosts }: { group: ProductionSummaryGroupDto; withCosts: boolean }) {
  return (
    <>
      {group.orders.map((o) => (
        <TableRow
          key={o.productionOrderId}
          className={DETAIL_ROW_CLASSNAME}
          data-testid="produccion-op"
        >
          <TableCell className="pl-8">
            <Link
              className={cn(LINK_CLASSNAME, 'font-mono')}
              href={`/produccion/${o.productionOrderId}`}
            >
              {o.code}
            </Link>
            <span className="text-muted-foreground">
              {' · '}
              {o.productSku}
              {o.lineNumber !== null && ` · línea ${String(o.lineNumber)}`}
              {` · ${quantityText(o)}`}
            </span>
          </TableCell>
          {/* La columna del pedido es «Órdenes»: la cantidad de la orden va junto a su código. */}
          <TableCell />
          <TableCell className="text-right">{formatKg(o.theoreticalKg, null)}</TableCell>
          <TableCell className="text-right">{formatKg(o.consumedKg, null)}</TableCell>
          <TableCell className="text-right">{formatKg(o.trimKg, null)}</TableCell>
          <TableCell className="text-right">
            <Pct value={o.wastePct} over={o.overStandard} />
          </TableCell>
          {withCosts && (
            <>
              <TableCell className="text-right">{amountOrDash(o.materialCostPen)}</TableCell>
              <TableCell className="text-right">{amountOrDash(o.trimCostPen)}</TableCell>
            </>
          )}
        </TableRow>
      ))}
    </>
  );
}

/** D-434: el porcentaje, en rojo solo si pasa la tolerancia del 1 % sobre el estándar. */
function Pct({ value, over }: { value: string | null; over: boolean }) {
  if (value === null) return <>—</>;
  return over ? <Badge variant="destructive">{value} %</Badge> : <span>{value} %</span>;
}

/** Un importe sin símbolo (la columna dice «S/»); sin costo (supervisor), guion. */
function amountOrDash(value: string | Decimal | null): string {
  return value === null ? '—' : formatAmount(value);
}

/** Coberturas Aluzinc y Drywall, sin «Todas» (como la merma, D-424); periodo, vista y orden sobreviven. */
const LINE_TABS: LineTabsConfig = {
  lines: COIL_REPORT_LINES,
  includeAll: false,
  keep: ['from', 'to', 'ver', 'sort', 'dir'],
};
