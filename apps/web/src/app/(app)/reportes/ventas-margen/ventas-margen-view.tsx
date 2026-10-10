'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  PROFIT_SOURCES_NOTICE,
  BUSINESS_LINE_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  NO_COST_REPORT_LINES,
  Role,
  SALES_MARGIN_LINES,
  toDecimal,
  type BusinessLine,
  type MarginCostStatus,
  type SalesMarginDto,
  type SalesMarginOrderDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatAmount, formatDate, formatMoney } from '@/lib/format';
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
import { keepPreviousInScope } from '@/lib/report-query';
import { Segmented } from '@/components/reports/segmented';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import {
  SALES_MARGIN_VIEWS,
  SALES_MARGIN_VIEW_LABELS,
  countLabel,
  filterSalesMargin,
  groupSalesMargin,
  salesMarginSearchText,
  parseSalesMarginView,
  summarizeSalesMargin,
  type SalesMarginGroup,
  type SalesMarginView,
} from '@/lib/sales-margin-groups';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME, cn } from '@/lib/utils';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Ventas y margen por rango (RF-S4a/M2). **Solo administrador**.
 *
 * La pantalla insiste en una distinción que un reporte de margen normalmente esconde: qué
 * tan comparable es el costo con la venta del rango. Una fila `PARCIAL` tiene costo de
 * verdad pero incompleto —el margen es un techo—, y una `NO_COMPARABLE` se muestra sin
 * costo y **fuera de los totales**, porque su venta del rango es una porción de un pedido
 * cuyo costo cubre más que eso. Prorratear daría un número inventado.
 *
 * cc32: con la plantilla de reportes —periodo único en la URL, «Cómo se calcula», tabla con
 * orden, búsqueda, detalle con chevron y total al pie, y «Ver por» Pedido / Vendedor / Cliente—.
 * Lo que se le pide al API y qué filas suman no cambian.
 */
export function VentasMargenView() {
  const periodState = useReportPeriod();
  const { period, valid } = periodState;
  const { tab, line, select } = useLineTab(LINE_TABS);
  const [url, setUrl] = useUrlState({ ver: 'pedido', search: '' });
  const view = parseSalesMarginView(url.ver);
  const [sort, toggleSort] = useSort<string>();
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  // D-392: Servicios no tiene costo registrado; su pestaña muestra solo la venta.
  const noCost = line !== undefined && NO_COST_REPORT_LINES.includes(line);
  const qs = `from=${period.from}&to=${period.to}${line === undefined ? '' : `&businessLine=${line}`}`;

  // El alcance es el reporte y su pestaña; el periodo va después (`keepPreviousInScope`).
  const scope = ['report', 'sales-margin', line ?? 'todas'];
  const report = useQuery({
    queryKey: [...scope, period.from, period.to],
    queryFn: () => api<SalesMarginDto>(`/reports/sales-margin?${qs}`),
    enabled: valid,
    // Al cambiar de periodo en la misma pestaña, el dato anterior queda a la vista, marcado,
    // mientras carga; al cambiar de pestaña, no (sería el dato de otra línea).
    placeholderData: keepPreviousInScope<SalesMarginDto>(scope),
  });
  // Con un rango inválido no se muestra nada viejo: solo el mensaje.
  const data = valid ? report.data : undefined;
  const loading = !periodState.complete || (valid && report.isPending);
  const updating = valid && report.isPlaceholderData;

  // D-412: en Servicios, la venta suma aunque el pedido tenga un costo no comparable o no
  // rastreable por otra línea (`inTotals`); esas secciones son solo de lo que quedó fuera.
  const excluded =
    data?.orders.filter((o) => !o.inTotals && o.costStatus === 'NO_COMPARABLE') ?? [];
  // D-285: despachados sin salida de kardex; su costo no se puede rastrear.
  const untraceable =
    data?.orders.filter((o) => !o.inTotals && o.costStatus === 'NO_RASTREABLE') ?? [];
  const included = data?.orders.filter((o) => o.inTotals) ?? [];
  const showOpMaterial = line === undefined;
  const searching = searchText.trim() !== '';

  const query = {
    isPending: loading,
    isError: report.isError,
    isSuccess: data !== undefined,
    refetch: report.refetch,
  };
  const emptyTitle =
    line === undefined
      ? 'No hay comprobantes emitidos en ese periodo'
      : 'No hay ventas de esta línea en ese periodo';
  const clearSearch = () => {
    setSearchText('');
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <ReportHeader
        title="Ventas y margen"
        subtitle="Comprobantes emitidos en el periodo, sin IGV."
        howItWorks={
          <HowItWorksText
            line={line}
            noCost={noCost}
            partialOrderCount={data?.totals.partialOrderCount ?? 0}
          />
        }
        actions={
          // Descarga directa contra el API (patrón D-149), con el periodo que se ve.
          // cc39 (D-580, reemplaza a D-396): el Excel de la pestaña que se ve, también por línea.
          valid ? (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/sales-margin/xlsx?from=${period.from}&to=${period.to}${line === undefined ? '' : `&businessLine=${line}`}`,
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
              <Figures data={data} line={line} noCost={noCost} included={included} />
            </BusyRegion>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Segmented<SalesMarginView>
              label="Ver por"
              showLabel
              value={view}
              options={SALES_MARGIN_VIEWS.map((v) => ({
                value: v,
                label: SALES_MARGIN_VIEW_LABELS[v],
              }))}
              onChange={(v) => {
                setUrl({ ver: v });
              }}
            />
            <Input
              type="search"
              aria-label="Buscar en el reporte"
              placeholder="Buscar pedido, cliente o comprobante"
              className="h-8 max-w-xs"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
              }}
            />
          </div>

          {view === 'pedido' ? (
            <ReportTable
              // Cambiar de vista vuelve a empezar: las filas abiertas son de la otra vista.
              key="pedido"
              testId="tabla-ventas-margen"
              rowTestId="fila-pedido"
              columns={orderColumns(!noCost)}
              rows={included}
              rowKey={orderKey}
              sort={sort}
              onSort={toggleSort}
              search={searchText}
              updating={updating}
              detail={(order) => (
                <OrderDetail order={order} cost={!noCost} opMaterial={showOpMaterial} />
              )}
              detailLabel={(order) => order.orderCode ?? 'la venta sin pedido'}
              footerLabel={(rows) => `Total · ${countLabel(summarizeSalesMargin(rows))}`}
              query={query}
              emptyTitle={emptyTitle}
              noResultsTitle={`Ningún pedido coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          ) : (
            <ReportTable
              key={view}
              testId="tabla-ventas-margen"
              rowTestId="fila-grupo"
              columns={groupColumns(view, !noCost)}
              // Se busca en las filas y se agrupa después: cada grupo y el pie suman solo los
              // pedidos que coinciden.
              rows={groupSalesMargin(
                filterSalesMargin(included, searchText, (o) => COST_STATUS_LABELS[o.costStatus]),
                view,
              )}
              rowKey={(g) => `g:${g.key}`}
              sort={sort}
              onSort={toggleSort}
              search=""
              filtered={searching && included.length > 0}
              updating={updating}
              detail={(group) => <GroupDetail group={group} view={view} cost={!noCost} />}
              detailLabel={(group) => group.label}
              footerLabel={(groups) => {
                const direct = groups.reduce((n, g) => n + g.directSaleCount, 0);
                return direct === 0
                  ? 'Total'
                  : `Total · ${plural(direct, 'venta sin pedido', 'ventas sin pedido')}`;
              }}
              query={query}
              emptyTitle={emptyTitle}
              noResultsTitle={`Ningún ${view === 'vendedor' ? 'vendedor' : 'cliente'} coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          )}

          <BusyRegion busy={updating} className="space-y-3">
            {data && excluded.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Facturación parcial en el periodo</h2>
                <p className="text-xs text-muted-foreground">
                  Estos pedidos tienen comprobantes dentro y fuera del periodo, y los del periodo no
                  declaran su despacho. Su costo cubre más venta que la que se ve aquí, así que se
                  muestra la venta y se deja el costo vacío: quedan fuera de los totales de arriba
                  (venta excluida: {formatMoney(data.totals.excludedSalesPen)}).
                  {line === undefined && SERVICES_STILL_COUNT}
                </p>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pedido</TableHead>
                        <TableHead>Cliente</TableHead>
                        <TableHead className="text-right">Venta en el periodo (S/)</TableHead>
                        {showOpMaterial && (
                          <TableHead className="hidden text-right xl:table-cell">
                            Material de órdenes (S/)
                          </TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {excluded.map((order) => (
                        <TableRow key={orderKey(order)}>
                          <TableCell>
                            <OrderCode order={order} />
                          </TableCell>
                          <TableCell>{order.customerName}</TableCell>
                          <TableCell className="text-right">
                            {formatAmount(order.salesPen)}
                          </TableCell>
                          {showOpMaterial && (
                            <TableCell className="hidden text-right xl:table-cell">
                              {formatAmount(order.opMaterialCostPen)}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}

            {data && untraceable.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Costo no rastreable</h2>
                <p className="text-xs text-muted-foreground">
                  Estos pedidos se despacharon sin su salida de inventario, así que no se sabe su
                  costo. Quedan fuera de los totales de arriba (venta excluida:{' '}
                  {formatMoney(data.totals.untraceableSalesPen)}).
                  {line === undefined && SERVICES_STILL_COUNT}
                </p>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pedido</TableHead>
                        <TableHead>Cliente</TableHead>
                        <TableHead className="text-right">Venta en el periodo (S/)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {untraceable.map((order) => (
                        <TableRow key={orderKey(order)}>
                          <TableCell>
                            <OrderCode order={order} />
                          </TableCell>
                          <TableCell>{order.customerName}</TableCell>
                          <TableCell className="text-right">
                            {formatAmount(order.salesPen)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}

            {/* En la pestaña de una línea, la tabla repetiría la franja de arriba: solo en «Todas». */}
            {data && line === undefined && <TotalsByLine data={data} />}
          </BusyRegion>
        </>
      )}
    </RoleGate>
  );
}

/** La franja de cifras: rótulos cortos y el matiz en una segunda línea. */
function Figures({
  data,
  line,
  noCost,
  included,
}: {
  data: SalesMarginDto;
  line: BusinessLine | undefined;
  noCost: boolean;
  included: readonly SalesMarginOrderDto[];
}) {
  // D-518: el mismo conteo que el pie de la tabla.
  const documents = included.reduce((n, o) => n + o.documents.length, 0);
  const counts = `${countLabel(summarizeSalesMargin(included))} · ${plural(documents, 'comprobante', 'comprobantes')}`;
  const partial = data.totals.partialOrderCount;
  // D-409/D-419: en «Todas», el margen se calcula sin la venta sin costo registrado.
  const withoutNoCost = line === undefined ? 'sin servicios ni líneas sin producto' : null;
  const partialHint =
    partial > 0 ? `${plural(partial, 'pedido', 'pedidos')} con costo parcial: es un techo` : null;
  if (noCost) {
    return (
      <StatStrip className="sm:grid-cols-2 lg:grid-cols-2">
        <Stat label="Venta" hint={counts}>
          {formatMoney(data.totals.salesPen)}
        </Stat>
        <Stat label="Costo y margen">{NO_COST_LABEL}</Stat>
      </StatStrip>
    );
  }
  return (
    <StatStrip
      data-testid="cifras-ventas-margen"
      className={
        line === undefined ? 'sm:grid-cols-3 lg:grid-cols-5' : 'sm:grid-cols-2 lg:grid-cols-4'
      }
    >
      <Stat label="Venta" hint={counts}>
        {formatMoney(data.totals.salesPen)}
      </Stat>
      <Stat label="Costo de venta">{formatMoney(data.totals.costPen)}</Stat>
      <Stat label="Margen" hint={hintLines([withoutNoCost, partialHint])}>
        {formatMoney(data.totals.marginPen)}
      </Stat>
      <Stat label="Margen %" hint={hintLines([withoutNoCost])}>
        {pctText(data.totals.marginPct)}
      </Stat>
      {/* D-409/D-419: en «Todas», la venta sin costo registrado (Servicios y líneas sin
          producto) suma a la venta y queda fuera del margen. */}
      {line === undefined && (
        <Stat label="Venta sin costo" hint="servicios y líneas sin producto">
          {formatMoney(data.totals.noCostSalesPen)}
        </Stat>
      )}
    </StatStrip>
  );
}

/** Los matices de una cifra, uno por línea; sin ninguno, `undefined` (la cifra no lleva línea). */
function hintLines(lines: readonly (string | null)[]): ReactNode {
  const shown = lines.filter((l): l is string => l !== null);
  if (shown.length === 0) return undefined;
  return shown.map((l) => (
    <span key={l} className="block">
      {l}
    </span>
  ));
}

/** La explicación larga, que antes ocupaba la cabecera y los avisos. No se pierde ningún texto. */
function HowItWorksText({
  line,
  noCost,
  partialOrderCount,
}: {
  line: BusinessLine | undefined;
  noCost: boolean;
  partialOrderCount: number;
}) {
  return (
    <>
      <p>
        Comprobantes emitidos en el periodo, sin IGV. Costo de venta desde el kardex. Cada fila es
        un pedido con sus comprobantes del periodo: ábrela con la flecha para verlos, con el
        material que consumieron sus órdenes de producción.
      </p>
      {/* C06: el aviso de los dos reportes, en palabras del dueño. */}
      <p data-testid="aviso-costeo">{PROFIT_SOURCES_NOTICE}</p>
      {noCost ? (
        <p>Servicios no tiene costo registrado: se muestra solo la venta, sin costo ni margen.</p>
      ) : (
        <>
          {line === undefined && (
            <p>
              La venta sin costo registrado (Servicios y líneas sin producto) suma a la venta y
              queda fuera del margen: el margen y el margen % de la franja se calculan sin ella.
            </p>
          )}
          <p>
            {partialOrderCount === 0
              ? '«Costo parcial»: hay líneas facturadas que todavía no salieron del almacén, así que el margen es un techo.'
              : partialOrderCount === 1
                ? '1 pedido tiene costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.'
                : `${String(partialOrderCount)} pedidos tienen costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.`}
          </p>
          <p>
            Los pedidos con facturación parcial en el periodo (no comparables) y los de costo no
            rastreable se listan debajo de la tabla y quedan fuera de los totales.
          </p>
          <p>
            Un comprobante sin costo («—») es uno cuyo despacho no está declarado: su costo queda en
            el pedido.
          </p>
        </>
      )}
      <p>
        El total al pie suma las filas de la tabla (con la búsqueda aplicada), con los valores
        completos y redondeado al final.
        {noCost
          ? ''
          : ' Su margen incluye la venta sin costo registrado de esos pedidos, así que puede no coincidir con el de la franja.'}{' '}
        «Ver por» Vendedor o Cliente agrupa esas mismas filas: la suma de los grupos es el total.
      </p>
      {line === undefined && (
        // D-412: la venta de Servicios de un pedido no comparable o no rastreable suma arriba.
        <p>
          La venta de la franja incluye también la venta de Servicios de los pedidos que se listan
          debajo como facturación parcial o costo no rastreable: esa venta no depende del costo y
          suma igual, aunque el pedido quede fuera de la tabla. Por eso la venta de la franja puede
          no coincidir con la del pie, no solo el margen.
        </p>
      )}
      <p>Se cuentan los pedidos; las ventas sin pedido (ventas directas) se nombran aparte.</p>
    </>
  );
}

/** El código del pedido como enlace; una venta directa sin pedido no tiene a dónde ir. */
function OrderCode({ order }: { order: SalesMarginOrderDto }) {
  if (order.salesOrderId === null || order.orderCode === null) {
    return <span className="font-mono">{order.orderCode ?? '—'}</span>;
  }
  return (
    <Link href={`/pedidos/${order.salesOrderId}`} className={cn('font-mono', LINK_CLASSNAME)}>
      {order.orderCode}
    </Link>
  );
}

function pctText(pct: string | null): string {
  return pct === null ? '—' : `${pct} %`;
}

/** Las columnas de la vista por pedido. `cost`: sin costo en Servicios (D-392). */
function orderColumns(cost: boolean): ReportColumn<SalesMarginOrderDto>[] {
  const columns: ReportColumn<SalesMarginOrderDto>[] = [
    {
      key: 'order',
      header: 'Pedido',
      cell: (o) => <OrderCode order={o} />,
      sortValue: { text: (o) => o.orderCode ?? '' },
      searchText: (o) => salesMarginSearchText(o, COST_STATUS_LABELS[o.costStatus]),
    },
    {
      key: 'customer',
      header: 'Cliente',
      cell: (o) => o.customerName,
      sortValue: { text: (o) => o.customerName },
    },
    {
      key: 'seller',
      header: 'Vendedor',
      className: 'hidden lg:table-cell',
      cell: (o) => o.sellerName ?? '—',
      sortValue: { text: (o) => o.sellerName ?? '' },
    },
    {
      key: 'sales',
      header: 'Venta (S/)',
      align: 'right',
      cell: (o) => formatAmount(o.salesPen),
      sortValue: { decimal: (o) => o.salesPen },
      total: (rows) => formatAmount(summarizeSalesMargin(rows).sales),
    },
  ];
  if (!cost) return columns;
  return [
    ...columns,
    {
      key: 'cost',
      header: 'Costo (S/)',
      align: 'right',
      cell: (o) => (o.costPen === null ? '—' : formatAmount(o.costPen)),
      sortValue: { decimal: (o) => o.costPen ?? '' },
      total: (rows) => formatAmount(summarizeSalesMargin(rows).cost),
    },
    {
      key: 'margin',
      header: 'Margen (S/)',
      align: 'right',
      cell: (o) => (o.marginPen === null ? '—' : formatAmount(o.marginPen)),
      sortValue: { decimal: (o) => o.marginPen ?? '' },
      total: (rows) => formatAmount(summarizeSalesMargin(rows).margin),
    },
    {
      key: 'pct',
      header: 'Margen %',
      align: 'right',
      cell: (o) => pctText(o.marginPct),
      sortValue: { decimal: (o) => o.marginPct ?? '' },
      total: (rows) => pctText(summarizeSalesMargin(rows).marginPct),
    },
    {
      key: 'status',
      header: 'Costo registrado',
      cell: (o) => <CostStatusBadge status={o.costStatus} />,
      sortValue: { text: (o) => COST_STATUS_LABELS[o.costStatus] },
    },
  ];
}

/** Los comprobantes del pedido, alineados con sus columnas, y el material de sus órdenes. */
function OrderDetail({
  order,
  cost,
  opMaterial,
}: {
  order: SalesMarginOrderDto;
  cost: boolean;
  opMaterial: boolean;
}) {
  return (
    <>
      {order.documents.map((d) => (
        <TableRow key={d.id} className={DETAIL_ROW_CLASSNAME} data-testid="detalle-comprobante">
          <TableCell className="pl-8">
            {d.number === null ? (
              <span className="font-mono">—</span>
            ) : (
              <Link href={`/comprobantes/${d.id}`} className={cn('font-mono', LINK_CLASSNAME)}>
                {d.number}
              </Link>
            )}
          </TableCell>
          <TableCell>
            {FISCAL_DOC_TYPE_LABELS[d.docType]} · {formatDate(d.issueDate)}
          </TableCell>
          <TableCell className="hidden lg:table-cell" />
          <TableCell className="text-right">{formatAmount(d.salesPen)}</TableCell>
          {cost && (
            <>
              <TableCell className="text-right">
                {d.costPen === null ? (
                  <span title="El despacho de este comprobante no está declarado">—</span>
                ) : (
                  formatAmount(d.costPen)
                )}
              </TableCell>
              <TableCell className="text-right">
                {d.marginPen === null ? '—' : formatAmount(d.marginPen)}
              </TableCell>
              <TableCell className="text-right">{pctText(d.marginPct)}</TableCell>
              <TableCell />
            </>
          )}
        </TableRow>
      ))}
      {/* cc32: «Material de OPs» salió de la tabla: es un dato de planta, no de margen. */}
      {opMaterial && (
        <TableRow className={DETAIL_ROW_CLASSNAME} data-testid="detalle-material">
          <TableCell colSpan={cost ? 8 : 4} className="pl-8 text-muted-foreground">
            Material de las órdenes de producción del pedido:{' '}
            <span className="font-medium text-foreground">
              {formatMoney(order.opMaterialCostPen)}
            </span>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Las columnas de «Ver por» Vendedor o Cliente. */
function groupColumns(
  view: Exclude<SalesMarginView, 'pedido'>,
  cost: boolean,
): ReportColumn<SalesMarginGroup>[] {
  // El pie suma las filas de los grupos a la vista, con los valores completos.
  const all = (groups: readonly SalesMarginGroup[]) =>
    summarizeSalesMargin(groups.flatMap((g) => g.orders));
  const columns: ReportColumn<SalesMarginGroup>[] = [
    {
      key: 'label',
      header: SALES_MARGIN_VIEW_LABELS[view],
      cell: (g) => g.label,
      sortValue: { text: (g) => g.label },
    },
    {
      key: 'count',
      header: 'Pedidos',
      align: 'right',
      cell: (g) => String(g.orderCount),
      sortValue: { decimal: (g) => String(g.orderCount) },
      total: (groups) => String(groups.reduce((n, g) => n + g.orderCount, 0)),
    },
    {
      key: 'sales',
      header: 'Venta (S/)',
      align: 'right',
      cell: (g) => formatAmount(g.sales),
      sortValue: { decimal: (g) => g.sales.toString() },
      total: (groups) => formatAmount(all(groups).sales),
    },
  ];
  if (!cost) return columns;
  return [
    ...columns,
    {
      key: 'cost',
      header: 'Costo (S/)',
      align: 'right',
      cell: (g) => formatAmount(g.cost),
      sortValue: { decimal: (g) => g.cost.toString() },
      total: (groups) => formatAmount(all(groups).cost),
    },
    {
      key: 'margin',
      header: 'Margen (S/)',
      align: 'right',
      cell: (g) => formatAmount(g.margin),
      sortValue: { decimal: (g) => g.margin.toString() },
      total: (groups) => formatAmount(all(groups).margin),
    },
    {
      key: 'pct',
      header: 'Margen %',
      align: 'right',
      cell: (g) => pctText(g.marginPct),
      sortValue: { decimal: (g) => g.marginPct ?? '' },
      total: (groups) => pctText(all(groups).marginPct),
    },
  ];
}

/** Los pedidos de un grupo, alineados con las columnas del grupo. */
function GroupDetail({
  group,
  view,
  cost,
}: {
  group: SalesMarginGroup;
  view: Exclude<SalesMarginView, 'pedido'>;
  cost: boolean;
}) {
  return (
    <>
      {group.orders.map((o) => (
        <TableRow key={orderKey(o)} className={DETAIL_ROW_CLASSNAME} data-testid="detalle-pedido">
          <TableCell className="pl-8">
            <OrderCode order={o} />
            <span className="text-muted-foreground">
              {' · '}
              {view === 'vendedor' ? o.customerName : (o.sellerName ?? '—')}
            </span>
            {cost && (
              <span className="ml-2">
                <CostStatusBadge status={o.costStatus} />
              </span>
            )}
          </TableCell>
          <TableCell />
          <TableCell className="text-right">{formatAmount(o.salesPen)}</TableCell>
          {cost && (
            <>
              <TableCell className="text-right">
                {o.costPen === null ? '—' : formatAmount(o.costPen)}
              </TableCell>
              <TableCell className="text-right">
                {o.marginPen === null ? '—' : formatAmount(o.marginPen)}
              </TableCell>
              <TableCell className="text-right">{pctText(o.marginPct)}</TableCell>
            </>
          )}
        </TableRow>
      ))}
    </>
  );
}

function TotalsByLine({ data }: { data: SalesMarginDto }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Totales por línea de negocio</h2>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Línea</TableHead>
              <TableHead className="text-right">Venta (S/)</TableHead>
              <TableHead className="text-right">Costo (S/)</TableHead>
              <TableHead className="text-right">Margen (S/)</TableHead>
              <TableHead className="text-right">Margen %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.totalsByLine.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  Sin ventas en el periodo.
                </TableCell>
              </TableRow>
            )}
            {data.totalsByLine.map((t) => (
              <TableRow key={t.businessLine ?? 'sin-linea'}>
                <TableCell>
                  {t.businessLine === null
                    ? 'Sin línea (servicios y ajustes)'
                    : BUSINESS_LINE_LABELS[t.businessLine]}
                </TableCell>
                <TableCell className="text-right">{formatAmount(t.salesPen)}</TableCell>
                {t.businessLine === null || NO_COST_REPORT_LINES.includes(t.businessLine) ? (
                  // D-392/D-419: Servicios y «Sin línea» suman igual; su costo no está registrado.
                  <TableCell colSpan={3} className="text-right text-muted-foreground">
                    {NO_COST_LABEL}
                  </TableCell>
                ) : (
                  <>
                    <TableCell className="text-right">{formatAmount(t.costPen)}</TableCell>
                    <TableCell className="text-right">{formatAmount(t.marginPen)}</TableCell>
                    <TableCell className="text-right">{pctText(t.marginPct)}</TableCell>
                  </>
                )}
              </TableRow>
            ))}
            {/* cc28 (D-461): lo que separa sumar comprobantes de sumar sus líneas. */}
            {!toDecimal(data.totals.roundingPen).isZero() && (
              <TableRow>
                <TableCell>Redondeo al céntimo de los comprobantes</TableCell>
                <TableCell className="text-right">
                  {formatAmount(data.totals.roundingPen, 4)}
                </TableCell>
                <TableCell colSpan={3} className="text-right text-muted-foreground">
                  Comprobantes con líneas de más de dos decimales (precio con IGV)
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

const COST_STATUS_LABELS: Record<MarginCostStatus, string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
  NO_RASTREABLE: 'Costo no rastreable',
};

function CostStatusBadge({ status }: { status: MarginCostStatus }) {
  if (status === 'COMPLETO') {
    return <Badge variant="secondary">{COST_STATUS_LABELS[status]}</Badge>;
  }
  return <Badge variant="destructive">{COST_STATUS_LABELS[status]}</Badge>;
}

function orderKey(order: SalesMarginOrderDto): string {
  return order.salesOrderId ?? order.documents[0]?.id ?? order.customerName;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * cc23 (D-391, D-393): todas las líneas, con «Todas» primera y por defecto. Al cambiar de
 * pestaña sobreviven el periodo y, desde cc32, la vista («Ver por») y el orden.
 */
const LINE_TABS: LineTabsConfig = {
  lines: SALES_MARGIN_LINES,
  includeAll: true,
  keep: ['from', 'to', 'ver', 'sort', 'dir'],
};

/** D-392: lo que se declara en lugar del costo y el margen de Servicios. */
const NO_COST_LABEL = 'Sin costo registrado';

/** D-412: por qué la venta de la fila puede ser mayor que la venta excluida. */
const SERVICES_STILL_COUNT =
  ' Si alguno de estos pedidos tiene venta de Servicios, esa venta no depende del costo y sí suma arriba.';
