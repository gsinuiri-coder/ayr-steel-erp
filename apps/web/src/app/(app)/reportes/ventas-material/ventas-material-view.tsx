'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  PROFIT_SOURCES_NOTICE,
  Role,
  SALES_BY_MATERIAL_LINES,
  SALES_BY_PRODUCT_LINES,
  SALES_MATERIAL_KIND_LABELS,
  SALES_PRODUCT_UNTRACEABLE_LABELS,
  SALES_MATERIAL_UNTRACEABLE_LABELS,
  toDecimal,
  businessToday,
  type SalesByMaterialDto,
  type SalesByMaterialLine,
  type SalesByProductDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
  type SalesMaterialRowDto,
  type SalesProductRowDto,
} from '@ayr/shared';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { ListStateMessage } from '@/components/list-state';
import { ReportHeader } from '@/components/reports/report-header';
import { PeriodPicker, useReportPeriod } from '@/components/reports/report-period';
import { legacyRangePeriod } from '@/lib/report-period';
import { BusyRegion, ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { Stat, StatStrip } from '@/components/stat-strip';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  formatAmount,
  formatDate,
  formatKg,
  formatMeters,
  formatMoney,
  formatUnitQty,
  unitSymbol,
} from '@/lib/format';
import { sumDecimal } from '@/lib/report-table';
import { allRows, materialFiguresOf } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { cn, LINK_CLASSNAME } from '@/lib/utils';

/**
 * cc24 (D-406, D-407): una pestaña por línea, sin «Todas», Coberturas Aluzinc por defecto. Al
 * cambiar de pestaña sobrevive el periodo; tipo, espesor y color son de la línea y se descartan.
 */
const LINE_TABS: LineTabsConfig = {
  lines: SALES_BY_MATERIAL_LINES,
  includeAll: false,
  keep: ['from', 'to'],
};

/** Los tipos de fila de cada pestaña (D-413: la bobina entera, en la línea de su bobina). */
const KINDS_BY_LINE: Record<SalesByMaterialLine, readonly SalesMaterialKind[]> = {
  [BusinessLine.METALLIC_ROOFING]: ['COBERTURA', 'ACCESORIO', 'BOBINA', 'PLANCHA'],
  [BusinessLine.DRYWALL]: ['PERFIL', 'BOBINA'],
  // D-417: por producto, sin tipo, espesor ni color.
  [BusinessLine.ROOFING]: [],
  [BusinessLine.TRADING]: [],
};

/** Lo que el cuadre deja fuera de las filas, según la línea (D-354, D-414). */
const UNCLASSIFIED_LABEL: Record<SalesByMaterialLine, string> = {
  [BusinessLine.METALLIC_ROOFING]: 'Productos de la línea sin subtipo',
  [BusinessLine.DRYWALL]: 'Productos comprados de Drywall (sin bobina)',
  [BusinessLine.ROOFING]: '',
  [BusinessLine.TRADING]: '',
};

/**
 * D-354 — Ventas por material. **Solo administrador**. cc24: por línea (Coberturas Aluzinc y
 * Drywall).
 *
 * Una fila por tipo × espesor × color del producto vendido, con las columnas de la planilla del
 * cliente. La venta es la de «Ventas y margen» (comprobantes del rango, sin IGV, netos de notas
 * de crédito); el peso real y el costo, los de las bobinas que consumió la producción de esas
 * líneas. Lo que no se puede trazar va aparte, con su motivo, y no se estima.
 *
 * cc32 (corte 2): con la plantilla de reportes —periodo único en la URL (el API ya pedía `from` y
 * `to`; el `range` de antes solo los calculaba en la web), «Cómo se calcula», tabla con orden,
 * búsqueda y total al pie—. La fila sigue abriendo el diálogo del desglose (D-370). Lo que se le
 * pide al API no cambia.
 */
export function VentasMaterialView() {
  const periodState = useReportPeriod();
  const { period, valid } = periodState;
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea de este reporte.
  const line = tab as SalesByMaterialLine;
  const lineLabel = BUSINESS_LINE_LABELS[line];
  const kinds = KINDS_BY_LINE[line];
  // D-417: Coberturas (UPVC) y Reventa van por producto, sin bobina.
  const byProduct = SALES_BY_PRODUCT_LINES.includes(line);
  const [url, setUrl] = useUrlState({
    tipo: '',
    espesor: '',
    color: '',
    search: '',
    // Solo para traducir los enlaces guardados de antes de cc32 (`range=month|prev`).
    range: '',
    from: '',
    to: '',
  });
  // Un enlace guardado con `range=month|prev` y sin fechas se traduce una vez al atajo y `range`
  // sale de la URL. Este efecto va después del de `useReportPeriod`, así que su `replace` gana.
  useEffect(() => {
    if (url.range === '') return;
    const legacy = legacyRangePeriod(url.range, url.from, url.to, businessToday());
    setUrl(legacy === null ? { range: '' } : { range: '', from: legacy.from, to: legacy.to });
  }, [url.range]);
  const [sort, toggleSort] = useSort<string>();
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const kind = (kinds as readonly string[]).includes(url.tipo)
    ? (url.tipo as SalesMaterialKind)
    : undefined;

  const base = `from=${period.from}&to=${period.to}&businessLine=${line}`;
  const filters = new URLSearchParams();
  if (kind !== undefined) filters.set('kind', kind);
  if (url.espesor !== '') filters.set('thicknessMm', url.espesor);
  if (url.color !== '') filters.set('color', url.color);
  const filterQs = filters.toString();
  const qs = filterQs === '' ? base : `${base}&${filterQs}`;

  // El alcance es el reporte, su pestaña y los filtros que no son periodo; el periodo va después
  // (`keepPreviousInScope`): al cambiar de periodo el dato anterior queda a la vista, atenuado;
  // al cambiar de pestaña o de filtro, no (serían otras filas con el nombre de estas).
  const scope = ['report', 'sales-by-material', line, filterQs];
  const report = useQuery({
    queryKey: [...scope, period.from, period.to],
    queryFn: () => api<SalesByMaterialDto>(`/reports/sales-by-material?${qs}`),
    enabled: valid,
    placeholderData: keepPreviousInScope<SalesByMaterialDto>(scope),
  });
  // Las opciones de espesor y color salen del rango sin filtrar (misma consulta sin filtros).
  const unfilteredScope = ['report', 'sales-by-material', line, ''];
  const unfiltered = useQuery({
    queryKey: [...unfilteredScope, period.from, period.to],
    queryFn: () => api<SalesByMaterialDto>(`/reports/sales-by-material?${base}`),
    enabled: valid,
    placeholderData: keepPreviousInScope<SalesByMaterialDto>(unfilteredScope),
  });

  const options = useMemo(() => {
    const rows = unfiltered.data?.rows ?? [];
    const thicknesses = [...new Set(rows.map((r) => r.thicknessMm))].sort((a, b) =>
      toDecimal(a).comparedTo(toDecimal(b)),
    );
    const colors = [...new Set(rows.map((r) => r.colorLabel))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    return { thicknesses, colors };
  }, [unfiltered.data]);

  // D-370: el desglose se abre desde la fila; ya no hay un botón para todas las filas.
  const [selected, setSelected] = useState<SalesMaterialRowDto | null>(null);
  const data = valid ? report.data : undefined;
  const updating = valid && report.isPlaceholderData;
  const loading = !periodState.complete || (valid && report.isPending);
  const query = {
    isPending: loading,
    isError: report.isError,
    isSuccess: data !== undefined,
    refetch: report.refetch,
  };
  const clearSearch = () => {
    setSearchText('');
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <ReportHeader
        title="Ventas por material"
        subtitle={
          byProduct
            ? `${lineLabel}. Venta, costo y utilidad por producto, sin IGV.`
            : `${lineLabel}. Venta, costo y rendimiento por tipo, espesor y color, sin IGV.`
        }
        howItWorks={
          <>
            <p>
              {lineLabel}. Comprobantes emitidos en el periodo, sin IGV, netos de notas de crédito;{' '}
              {byProduct
                ? // D-417 (autorrevisión de cc24, P2-1): sin bobina, el costo es el del despacho.
                  'costo de kardex de los despachos que declaran el comprobante.'
                : 'peso real y costo de las bobinas que consumió la producción.'}
            </p>
            {/* C06: el aviso de los dos reportes, en palabras del dueño. No aplica a las pestañas
                por producto, cuyo costo es el mismo de «Ventas y margen» (D-417). */}
            {!byProduct && <p data-testid="aviso-costeo">{PROFIT_SOURCES_NOTICE}</p>}
            {!byProduct && (
              <p>
                Rendimiento = peso teórico − peso real. Haz clic en una fila para ver las bobinas
                que alimentaron esa venta y, por bobina, sus comprobantes.
              </p>
            )}
            <p>
              Lo que no se puede trazar va en «No trazable», con su motivo: no se estima y queda
              fuera de las filas.
            </p>
            <p>
              El total al pie suma las filas de la tabla (con la búsqueda aplicada), con los valores
              completos y redondeado al final; los valores por kilo, por metro y por unidad salen de
              esas sumas.
            </p>
          </>
        }
        actions={
          // cc39 (D-580, reemplaza a D-416): el Excel de la pestaña que se ve, con el periodo y
          // los filtros (`qs` lleva la línea).
          valid ? (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/sales-by-material/xlsx?${qs}`,
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
              <Figures data={data} />
            </BusyRegion>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!byProduct && (
              <>
                <FilterSelect
                  label="Tipo"
                  value={url.tipo}
                  onChange={(v) => {
                    setUrl({ tipo: v });
                  }}
                  options={kinds.map((k) => ({
                    value: k,
                    label: SALES_MATERIAL_KIND_LABELS[k],
                  }))}
                />
                <FilterSelect
                  label="Espesor"
                  value={url.espesor}
                  onChange={(v) => {
                    setUrl({ espesor: v });
                  }}
                  options={options.thicknesses.map((t) => ({ value: t, label: `${t} mm` }))}
                />
                <FilterSelect
                  label="Color"
                  value={url.color}
                  onChange={(v) => {
                    setUrl({ color: v });
                  }}
                  options={options.colors.map((c) => ({ value: c, label: c }))}
                />
              </>
            )}
            <Input
              type="search"
              aria-label="Buscar en el reporte"
              placeholder={byProduct ? 'Buscar SKU o producto' : 'Buscar tipo, espesor o color'}
              className="h-8 max-w-xs"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
              }}
            />
          </div>

          {byProduct ? (
            <ReportTable
              testId="ventas-producto"
              rowTestId="fila-producto"
              columns={productColumns(data?.products ?? null)}
              rows={data?.products?.rows ?? []}
              rowKey={(r) => r.sku}
              sort={sort}
              onSort={toggleSort}
              search={searchText}
              updating={updating}
              footerLabel={({ length: n }) =>
                `Total · ${n === 1 ? '1 producto' : `${String(n)} productos`}`
              }
              query={query}
              emptyTitle="No hay ventas con costo trazable en ese periodo"
              noResultsTitle={`Ningún producto coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          ) : (
            <ReportTable
              testId="ventas-material"
              rowTestId="fila-material"
              columns={materialColumns(data)}
              rows={data?.rows ?? []}
              rowKey={(r) => `${r.kind}-${r.thicknessMm}-${r.colorLabel}`}
              sort={sort}
              onSort={toggleSort}
              search={searchText}
              updating={updating}
              onRowActivate={setSelected}
              rowTitle="Ver el desglose por bobina y comprobante"
              rowLabel={(r) =>
                `Ver el desglose de ${SALES_MATERIAL_KIND_LABELS[r.kind]} ${r.thicknessMm} mm ${r.colorLabel}`
              }
              footerLabel={() => 'Total'}
              query={query}
              emptyTitle={`No hay ventas trazables de ${lineLabel} en ese periodo`}
              noResultsTitle={`Ninguna fila coincide con «${searchText.trim()}»`}
              onClearSearch={clearSearch}
              errorTitle="No se pudo cargar el reporte"
            />
          )}

          {data && (
            <BusyRegion busy={updating} className="space-y-3">
              {data.products === null && data.subtotals.length > 0 && <KindSubtotals data={data} />}
              {data.products === null && data.untraceable.length > 0 && (
                <MaterialUntraceable data={data} />
              )}
              {data.products && data.products.untraceable.length > 0 && (
                <ProductUntraceable
                  products={data.products}
                  untraceableSalesPen={data.untraceableSalesPen}
                />
              )}
              <ReconciliationNotes data={data} line={line} from={period.from} to={period.to} />
            </BusyRegion>
          )}
        </>
      )}

      <MaterialBreakdownDialog
        row={selected}
        onClose={() => {
          setSelected(null);
        }}
      />
    </RoleGate>
  );
}

/** La franja de cifras: rótulos cortos y el matiz en una segunda línea. */
function Figures({ data }: { data: SalesByMaterialDto }) {
  const untraceableHint = toDecimal(data.untraceableSalesPen).isZero()
    ? undefined
    : `${formatMoney(data.untraceableSalesPen)} no trazable, aparte`;
  if (data.products) {
    const t = data.products.total;
    return (
      <StatStrip className="sm:grid-cols-3 lg:grid-cols-3" data-testid="cifras-ventas-material">
        <Stat label="Venta" hint={untraceableHint}>
          {formatMoney(t.salesPen)}
        </Stat>
        <Stat label="Costo">{formatMoney(t.costPen)}</Stat>
        <Stat label="Utilidad">{formatMoney(t.profitPen)}</Stat>
      </StatStrip>
    );
  }
  const t = data.total;
  return (
    <StatStrip className="sm:grid-cols-3 lg:grid-cols-5" data-testid="cifras-ventas-material">
      <Stat label="Venta" hint={untraceableHint}>
        {formatMoney(t.salesPen)}
      </Stat>
      <Stat label="Costo prod.">{formatMoney(t.costPen)}</Stat>
      <Stat label="Utilidad">{formatMoney(t.profitPen)}</Stat>
      <Stat label="Peso real (kg)" hint={`teórico ${formatKg(t.theoreticalKg)}`}>
        {formatKg(t.realKg, null)}
      </Stat>
      <Stat label="ML vendido (m)">{formatMeters(t.metersSold, null)}</Stat>
    </StatStrip>
  );
}

/** Un cociente: sin divisor (cantidad o metros en 0), «—», nunca 0 ni NaN. */
function perKg(value: string | null): string {
  return value === null ? '—' : formatAmount(value, 4);
}

/** C06: costo promedio por unidad de venta, con su unidad («10.0000 /m»). */
function perUnit(value: string | null, unit: string | null): string {
  if (value === null || unit === null) return '—';
  const symbol = unitSymbol(unit);
  return symbol === '' ? perKg(value) : `${perKg(value)} /${symbol}`;
}

/** Las columnas de cifras de la planilla del cliente, iguales en filas, subtotales y total. */
function figureColumns(
  total: (rows: readonly SalesMaterialRowDto[]) => SalesMaterialFiguresDto,
): ReportColumn<SalesMaterialRowDto>[] {
  const figure = (
    key: string,
    header: string,
    value: (f: SalesMaterialFiguresDto) => string | null,
    format: (v: string | null, f: SalesMaterialFiguresDto) => string,
  ): ReportColumn<SalesMaterialRowDto> => ({
    key,
    header,
    align: 'right',
    cell: (r) => format(value(r), r),
    sortValue: { decimal: (r) => value(r) ?? '' },
    total: (rows) => {
      const t = total(rows);
      return format(value(t), t);
    },
  });
  const kg = (v: string | null) => (v === null ? '—' : formatKg(v, null));
  const money = (v: string | null) => (v === null ? '—' : formatAmount(v));
  return [
    figure(
      'meters',
      'ML vendido (m)',
      (f) => f.metersSold,
      (v) => (v === null ? '—' : formatMeters(v, null)),
    ),
    figure('theoretical', 'Peso teórico (kg)', (f) => f.theoreticalKg, kg),
    figure('real', 'Peso real (kg)', (f) => f.realKg, kg),
    {
      key: 'yield',
      header: 'Rendimiento (kg)',
      align: 'right',
      cell: (r) => <YieldCell figures={r} />,
      sortValue: { decimal: (r) => r.yieldKg },
      total: (rows) => <YieldCell figures={total(rows)} />,
    },
    figure('sales', 'Venta (S/)', (f) => f.salesPen, money),
    figure('cost', 'Costo prod. (S/)', (f) => f.costPen, money),
    figure('profit', 'Utilidad (S/)', (f) => f.profitPen, money),
    figure('costPerKg', 'Costo/kg compra (S/)', (f) => f.costPerKgPen, perKg),
    figure('pricePerKg', 'Precio/kg venta (S/)', (f) => f.pricePerKgPen, perKg),
    figure('marginPerKg', 'Margen/kg (S/)', (f) => f.marginPerKgPen, perKg),
    // C06: por metro lineal y por unidad de venta.
    figure('pricePerMeter', 'Precio/ML venta (S/)', (f) => f.pricePerMeterPen, perKg),
    figure('costPerMeter', 'Costo/ML (S/)', (f) => f.costPerMeterPen, perKg),
    figure('marginPerMeter', 'Ganancia/ML (S/)', (f) => f.marginPerMeterPen, perKg),
    figure(
      'costPerUnit',
      'Costo prom./unidad (S/)',
      (f) => f.costPerUnitPen,
      (v, f) => perUnit(v, f.unit),
    ),
  ];
}

/** Teórico − real, y el porcentaje sobre el teórico. */
function YieldCell({ figures }: { figures: SalesMaterialFiguresDto }) {
  return (
    <span title="Teórico − real">
      {formatKg(figures.yieldKg, null)}
      {figures.yieldPct !== null && (
        <span className="ml-1 text-muted-foreground">({figures.yieldPct} %)</span>
      )}
    </span>
  );
}

function materialColumns(
  data: SalesByMaterialDto | undefined,
): ReportColumn<SalesMaterialRowDto>[] {
  // Sin búsqueda, el total del API; con búsqueda, el de las filas a la vista.
  const total = (rows: readonly SalesMaterialRowDto[]) =>
    data && allRows(rows, data.rows) ? data.total : materialFiguresOf(rows);
  return [
    {
      key: 'kind',
      header: 'Tipo',
      cell: (r) => SALES_MATERIAL_KIND_LABELS[r.kind],
      sortValue: { text: (r) => SALES_MATERIAL_KIND_LABELS[r.kind] },
      searchText: (r) => SALES_MATERIAL_KIND_LABELS[r.kind],
    },
    {
      key: 'thickness',
      header: 'Espesor (mm)',
      align: 'right',
      cell: (r) => r.thicknessMm,
      sortValue: { decimal: (r) => r.thicknessMm },
      searchText: (r) => [r.thicknessMm, `${r.thicknessMm} mm`],
    },
    {
      key: 'color',
      header: 'Color',
      cell: (r) => r.colorLabel,
      sortValue: { text: (r) => r.colorLabel },
      searchText: (r) => [r.colorLabel, ...r.coils.map((c) => c.code)],
    },
    ...figureColumns(total),
  ];
}

/** D-354: el subtotal de cada tipo, como lo trae el API (sin la búsqueda). */
function KindSubtotals({ data }: { data: SalesByMaterialDto }) {
  const columns = figureColumns(() => data.total);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Subtotales por tipo</h2>
      <div className="rounded-md border">
        <Table data-testid="subtotales-material">
          <TableHeader>
            <TableRow>
              <TableHead>Tipo</TableHead>
              {columns.map((c) => (
                <TableHead key={c.key} className="text-right">
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.subtotals.map((sub) => (
              <TableRow key={sub.kind} data-testid="subtotal-material">
                <TableCell>Subtotal {SALES_MATERIAL_KIND_LABELS[sub.kind]}</TableCell>
                {columns.map((c) => (
                  <TableCell key={c.key} className="text-right">
                    {/* Las celdas solo leen las cifras, que el subtotal tiene igual que una fila. */}
                    {c.cell(sub as SalesMaterialRowDto)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** El comprobante como enlace a su detalle. */
function DocumentLink({ id, number }: { id: string; number: string | null }) {
  return (
    <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/comprobantes/${id}`}>
      {number ?? 'Sin número'}
    </Link>
  );
}

function MaterialUntraceable({ data }: { data: SalesByMaterialDto }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">No trazable</h2>
      <p className="text-xs text-muted-foreground">
        Ventas del periodo cuyo peso real y costo no salen del kardex de una bobina. No se estiman:
        quedan fuera de las filas de arriba (venta: {formatMoney(data.untraceableSalesPen)}).
      </p>
      <div className="rounded-md border">
        <Table data-testid="ventas-material-no-trazable">
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Pedido</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead className="text-right">ML (m)</TableHead>
              <TableHead className="text-right">Venta (S/)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.untraceable.map((u, i) => (
              <TableRow key={`${u.documentId}-${u.sku}-${u.reason}-${String(i)}`}>
                <TableCell>
                  <DocumentLink id={u.documentId} number={u.documentNumber} />
                </TableCell>
                <TableCell>{formatDate(u.issueDate)}</TableCell>
                {/* El DTO trae el código del pedido sin su id: no se puede enlazar. */}
                <TableCell className="font-mono">{u.orderCode ?? '—'}</TableCell>
                <TableCell className="font-mono">{u.sku}</TableCell>
                <TableCell>
                  {SALES_MATERIAL_KIND_LABELS[u.kind]} {u.thicknessMm} mm {u.colorLabel}
                </TableCell>
                <TableCell>{SALES_MATERIAL_UNTRACEABLE_LABELS[u.reason]}</TableCell>
                <TableCell className="text-right">{formatMeters(u.metersSold, null)}</TableCell>
                <TableCell className="text-right">{formatAmount(u.salesPen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={6} className="font-normal text-muted-foreground">
                Total no trazable
              </TableCell>
              <TableCell className="text-right">
                {formatMeters(
                  sumDecimal(data.untraceable, (u) => u.metersSold),
                  null,
                )}
              </TableCell>
              <TableCell className="text-right font-semibold">
                {formatAmount(data.untraceableSalesPen)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </section>
  );
}

/**
 * D-417 — Coberturas (UPVC) y Reventa: una fila por producto, con el costo de kardex de los
 * despachos que declaran el comprobante (el mismo dato que «Ventas y margen»).
 */
function productColumns(products: SalesByProductDto | null): ReportColumn<SalesProductRowDto>[] {
  const unfiltered = (rows: readonly SalesProductRowDto[]) =>
    products !== null && allRows(rows, products.rows);
  const sum = (
    rows: readonly SalesProductRowDto[],
    key: 'salesPen' | 'costPen' | 'profitPen',
  ): string =>
    formatAmount(
      unfiltered(rows) && products ? products.total[key] : sumDecimal(rows, (r) => r[key]),
    );
  return [
    {
      key: 'sku',
      header: 'SKU',
      cell: (r) => <span className="font-mono">{r.sku}</span>,
      sortValue: { text: (r) => r.sku },
      searchText: (r) => r.sku,
    },
    {
      key: 'name',
      header: 'Producto',
      cell: (r) => r.name,
      sortValue: { text: (r) => r.name },
      searchText: (r) => r.name,
    },
    {
      // La unidad cambia de un producto a otro: va en la celda.
      key: 'qty',
      header: 'Cantidad',
      align: 'right',
      cell: (r) => formatUnitQty(r.qty, r.unit),
      sortValue: { decimal: (r) => r.qty },
    },
    {
      key: 'sales',
      header: 'Venta (S/)',
      align: 'right',
      cell: (r) => formatAmount(r.salesPen),
      sortValue: { decimal: (r) => r.salesPen },
      total: (rows) => sum(rows, 'salesPen'),
    },
    {
      key: 'cost',
      header: 'Costo (S/)',
      align: 'right',
      cell: (r) => formatAmount(r.costPen),
      sortValue: { decimal: (r) => r.costPen },
      total: (rows) => sum(rows, 'costPen'),
    },
    {
      key: 'profit',
      header: 'Utilidad (S/)',
      align: 'right',
      cell: (r) => formatAmount(r.profitPen),
      sortValue: { decimal: (r) => r.profitPen },
      total: (rows) => sum(rows, 'profitPen'),
    },
    {
      key: 'costPerUnit',
      header: 'Costo prom./unidad (S/)',
      align: 'right',
      cell: (r) => perUnit(r.costPerUnitPen, r.unit),
      sortValue: { decimal: (r) => r.costPerUnitPen ?? '' },
    },
  ];
}

function ProductUntraceable({
  products,
  untraceableSalesPen,
}: {
  products: SalesByProductDto;
  untraceableSalesPen: string;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">No trazable</h2>
      <p className="text-xs text-muted-foreground">
        Ventas del periodo cuyo costo no sale de un despacho que declare el comprobante. No se
        estiman: quedan fuera de las filas de arriba (venta: {formatMoney(untraceableSalesPen)}).
      </p>
      <div className="rounded-md border">
        <Table data-testid="ventas-producto-no-trazable">
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Pedido</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Venta (S/)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.untraceable.map((u, i) => (
              <TableRow key={`${u.documentId}-${u.sku}-${u.reason}-${String(i)}`}>
                <TableCell>
                  <DocumentLink id={u.documentId} number={u.documentNumber} />
                </TableCell>
                <TableCell>{formatDate(u.issueDate)}</TableCell>
                <TableCell className="font-mono">{u.orderCode ?? '—'}</TableCell>
                <TableCell className="font-mono">{u.sku}</TableCell>
                <TableCell>{SALES_PRODUCT_UNTRACEABLE_LABELS[u.reason]}</TableCell>
                <TableCell className="text-right">{formatUnitQty(u.qty, u.unit)}</TableCell>
                <TableCell className="text-right">{formatAmount(u.salesPen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={6} className="font-normal text-muted-foreground">
                Total no trazable
              </TableCell>
              <TableCell className="text-right font-semibold">
                {formatAmount(untraceableSalesPen)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </section>
  );
}

/**
 * El cuadre con «Ventas y margen» y el aviso de lo que no tiene línea (D-354, D-407, D-413).
 *
 * Lo que se muestra es el cuadre por comprobante, sin filtros: la venta de todas las líneas de
 * la línea de negocio facturadas en el rango. «Ventas y margen» la suma en la pestaña de la
 * línea, contando los pedidos que deja fuera de sus totales (no comparables o no rastreables), y
 * las bobinas enteras las cuenta dentro de Reventa (D-247): la leyenda lo dice para no prometer
 * una cifra que allá no aparece tal cual.
 */
function ReconciliationNotes({
  data,
  line,
  from,
  to,
}: {
  data: SalesByMaterialDto;
  line: SalesByMaterialLine;
  from: string;
  to: string;
}) {
  const lineLabel = BUSINESS_LINE_LABELS[line];
  const { lineSalesPen, coilSalesPen, unclassifiedSalesPen } = data.reconciliation;
  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="cuadre-ventas-margen">
        Cuadre con Ventas y margen (sin filtros): venta de {lineLabel} facturada en el periodo{' '}
        {formatMoney(lineSalesPen)} (allá, en la pestaña de la línea, más los pedidos que deja fuera
        de sus totales)
        {line === BusinessLine.TRADING
          ? // D-413: la bobina entera vive en la pestaña de la línea de su bobina.
            `; de ella, ${formatMoney(coilSalesPen)} son bobinas enteras de Coberturas Aluzinc o Drywall, que se muestran en esas pestañas.`
          : line === BusinessLine.ROOFING
            ? '.'
            : `; bobinas enteras de ${lineLabel} ${formatMoney(coilSalesPen)} (allá, dentro de Reventa).`}
        {unclassifiedSalesPen !== '0.0000' &&
          ` ${UNCLASSIFIED_LABEL[line]}, fuera de las filas: ${formatMoney(unclassifiedSalesPen)}.`}
      </p>
      {/* D-407: lo que no tiene línea de negocio no se reparte entre las pestañas. */}
      {data.noLineSalesPen !== '0.0000' && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="aviso-sin-linea">
          En el periodo hay {formatMoney(data.noLineSalesPen)} de venta sin línea de negocio (líneas
          de comprobante sin producto). No entra en ninguna pestaña:{' '}
          <Link className={LINK_CLASSNAME} href={`/reportes/ventas-margen?from=${from}&to=${to}`}>
            ver en Ventas y margen
          </Link>
          .
        </p>
      )}
    </>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">Todos</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * D-370 — desglose de una fila, en dos niveles.
 *
 * Nivel 1: las bobinas que alimentaron la venta de la fila (por tolerancia de espesor pudo ser
 * otra que la del producto, D-086), con el costo de kardex de lo consumido como dato principal y
 * el costo promedio por kg de la bobina debajo. Nivel 2: por bobina, los comprobantes que se
 * llevaron sus kilos y metros (una nota de crédito resta).
 *
 * cc32 (corte 2): se conserva; solo las unidades pasan al encabezado.
 */
function MaterialBreakdownDialog({
  row,
  onClose,
}: {
  row: SalesMaterialRowDto | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (coilId: string): void => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(coilId)) next.delete(coilId);
      else next.add(coilId);
      return next;
    });
  };
  const coils = row?.coils ?? [];
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) {
          setExpanded(new Set());
          onClose();
        }
      }}
    >
      {/* `sm:max-w-*` con prefijo: `cn()` no desduplica un `max-w-*` sin variante contra el
          `sm:max-w-sm` por defecto de DialogContent, y el modal quedaba en 384px. */}
      <DialogContent className="sm:max-w-5xl" data-testid="desglose-material">
        <DialogHeader>
          <DialogTitle>
            {row === null
              ? ''
              : `${SALES_MATERIAL_KIND_LABELS[row.kind]} ${row.thicknessMm} mm ${row.colorLabel}`}
          </DialogTitle>
          <DialogDescription>
            {coils.length === 1 ? '1 bobina' : `${String(coils.length)} bobinas`} alimentaron esta
            venta. Espesor y color son los de cada bobina: por tolerancia (±0,02 mm) pudo usarse
            otra que la del producto. Abre una bobina para ver sus comprobantes.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {row?.kind === 'PERFIL'
            ? // D-414: Drywall no rola metros; su teórico es el peso por pieza del catálogo.
              'Peso teórico de la fila = piezas vendidas × kg por pieza del producto, repartido entre los flejes por sus kilos. '
            : 'Peso teórico de la fila = suma del teórico de estas bobinas (metros rolados × ancho × espesor de la bobina × densidad del acabado, sin el 1 % de merma). '}
          Peso real y Costo prod. = suma de lo consumido y su costo.
        </p>
        <div className="max-h-[65vh] overflow-auto rounded-md border">
          <Table data-testid="bobinas-material">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Bobina</TableHead>
                <TableHead className="text-right">Espesor real (mm)</TableHead>
                <TableHead>Color</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Consumido (kg)</TableHead>
                <TableHead className="text-right">Costo prod. (S/)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coils.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    Sin bobinas.
                  </TableCell>
                </TableRow>
              )}
              {coils.map((coil) => {
                const open = expanded.has(coil.coilId);
                const panelId = `docs-${coil.coilId}`;
                return (
                  <Fragment key={coil.coilId}>
                    <TableRow data-testid="bobina-material">
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={open}
                          aria-controls={open ? panelId : undefined}
                          aria-label={`${open ? 'Ocultar' : 'Ver'} comprobantes de ${coil.code}`}
                          onClick={() => {
                            toggle(coil.coilId);
                          }}
                        >
                          <ChevronRight
                            className={cn('size-4 transition-transform', open && 'rotate-90')}
                          />
                        </Button>
                      </TableCell>
                      <TableCell className="font-mono">
                        <Link className={LINK_CLASSNAME} href={`/bobinas/${coil.coilId}`}>
                          {coil.code}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">{coil.thicknessMm}</TableCell>
                      <TableCell>{coil.colorLabel}</TableCell>
                      <TableCell>{coil.typeKey}</TableCell>
                      <TableCell className="text-right">
                        {formatKg(coil.kg, null)}
                        {/* Lo que suma al peso teórico de la fila, para poder verificarlo. */}
                        <div className="text-xs text-muted-foreground">
                          teórico {formatKg(coil.theoreticalKg)} · {formatMeters(coil.meters)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatAmount(coil.costPen)}
                        <div className="text-xs text-muted-foreground">
                          {coil.avgCostPen === null
                            ? 'sin costo promedio'
                            : `prom. ${formatMoney(coil.avgCostPen, 'PEN', 4)} /kg`}
                        </div>
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow id={panelId} className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6} className="p-2">
                          <Table data-testid="comprobantes-bobina">
                            <TableHeader>
                              <TableRow>
                                <TableHead>Comprobante</TableHead>
                                <TableHead>Fecha</TableHead>
                                <TableHead>Cliente</TableHead>
                                <TableHead className="text-right">Atribuido (kg)</TableHead>
                                <TableHead className="text-right">Atribuido (m)</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {coil.documents.map((doc) => (
                                <TableRow key={doc.documentId}>
                                  <TableCell>
                                    <DocumentLink id={doc.documentId} number={doc.documentNumber} />
                                  </TableCell>
                                  <TableCell>{formatDate(doc.issueDate)}</TableCell>
                                  <TableCell>{doc.customerName}</TableCell>
                                  <TableCell className="text-right">
                                    {formatKg(doc.kg, null)}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {formatMeters(doc.meters, null)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
