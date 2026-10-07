'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_REPORT_LINES,
  coilStateLabel,
  Role,
  toDecimal,
  type CoilFilmState,
  type CoilMonthReportDto,
  type CoilMonthReportRowDto,
  type CoilMonthReportSectionDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatAmount, formatKg, formatMoney, formatQty } from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { ListStateMessage } from '@/components/list-state';
import { ReportHeader } from '@/components/reports/report-header';
import { MonthPicker, useReportMonth } from '@/components/reports/report-period';
import { BusyRegion, ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { filterReportRows } from '@/lib/report-table';
import { allRows, coilMonthTotalsOf } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { RoleGate } from '@/components/role-gate';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME, cn } from '@/lib/utils';

/**
 * Reporte mensual de bobinas.
 *
 * La columna que lo justifica es **Saldo inicio de mes**: cuántos kilos tenía cada bobina el
 * primer día del mes. Sale de sumar los movimientos de kardex anteriores al corte por su
 * fecha de operación (D-124), así que antes de que esa fecha existiera este reporte no se
 * podía calcular: todo lo registrado quedaba fechado el día en que se tipeó.
 *
 * "Saldo fin de mes" y no "Disponible": en un reporte de agosto, mostrar el saldo de hoy
 * sería mezclar dos cortes en la misma fila. En el mes en curso las dos cifras coinciden.
 *
 * D-328: va en **dos tablas** —«Selladas» y «Abiertas»— según el film de cada bobina **al último
 * día del mes**, cada una con su subtotal.
 *
 * D-355: las tablas listan solo las bobinas **vigentes** al último día del mes. Las terminadas o
 * agotadas y las anuladas con saldo al inicio se resumen en una línea debajo; una anulada en el
 * mismo mes de su alta no figura. El total de la pestaña (cc24, D-408) sigue siendo el de todas, y el cuadre (inicio
 * + altas − salidas = cierre) va debajo.
 *
 * cc32 (corte 2): con la plantilla de reportes —el mes siempre en la URL con el mismo estilo que
 * el periodo, «Cómo se calcula», tablas con orden, búsqueda y subtotal al pie—. Lo que se le pide
 * al API no cambia.
 */
/**
 * cc24 (D-408, D-418): Coberturas Aluzinc y Drywall, sin «Todas» (D-393), Aluzinc por defecto.
 * El mes y el orden de las dos tablas sobreviven al cambio de pestaña.
 */
const LINE_TABS: LineTabsConfig = {
  lines: COIL_REPORT_LINES,
  includeAll: false,
  keep: ['mes', 'selladasort', 'selladadir', 'abiertasort', 'abiertadir'],
};

export function ReporteBobinasView() {
  const monthState = useReportMonth();
  const { month, valid } = monthState;
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea con bobinas.
  const line = tab as (typeof COIL_REPORT_LINES)[number];
  const [url, setUrl] = useUrlState({ search: '' });
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const qs = `month=${month}&businessLine=${line}`;

  // El alcance es el reporte y su pestaña; el mes va después (`keepPreviousInScope`).
  const scope = ['report', 'coils', line];
  const report = useQuery({
    queryKey: [...scope, month],
    queryFn: () => api<CoilMonthReportDto>(`/reports/coils?${qs}`),
    enabled: valid,
    // Al cambiar de mes, el dato anterior queda a la vista (atenuado) mientras carga.
    placeholderData: keepPreviousInScope<CoilMonthReportDto>(scope),
  });
  const data = valid ? report.data : undefined;
  const updating = valid && report.isPlaceholderData;
  const loading = !monthState.complete || (valid && report.isPending);
  const query = {
    isPending: loading,
    isError: report.isError,
    isSuccess: data !== undefined,
    refetch: report.refetch,
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <ReportHeader
        title="Reporte mensual de bobinas"
        subtitle="Saldo de cada bobina al inicio y al fin del mes."
        howItWorks={
          <>
            <p>
              «Saldo inicio de mes» es lo que tenía cada bobina el primer día del mes: sale de sumar
              los movimientos de kardex anteriores, por su fecha de operación. «Saldo fin de mes» es
              el del último día del mes; en el mes en curso, el de hoy.
            </p>
            <p>
              Las bobinas van en dos tablas según su film al último día del mes: selladas y
              abiertas, cada una con su subtotal. Solo se listan las vigentes (con saldo al fin del
              mes). Las terminadas o agotadas y las anuladas con saldo al inicio se resumen debajo;
              una anulada en el mismo mes de su alta no figura.
            </p>
            <p>
              Las cifras de arriba son el total de la pestaña, de todas las bobinas del mes
              (listadas o no), y el cuadre de debajo dice: saldo inicio + altas − salidas = saldo
              fin de mes.
            </p>
            <p>
              El subtotal al pie de cada tabla suma sus filas (con la búsqueda aplicada), con los
              valores completos y redondeado al final.
            </p>
          </>
        }
        actions={
          // D-355: descargas directas contra el API (patrón D-149), del mismo mes que se ve.
          // D-408/D-418: el PDF y el Excel siguen la pestaña.
          valid ? (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/coils/xlsx?${qs}`,
                },
                {
                  key: 'pdf',
                  label: 'Descargar PDF',
                  download: `/api/reports/coils/pdf?${qs}`,
                },
              ]}
            />
          ) : undefined
        }
      />

      <MonthPicker state={monthState} updating={updating} />

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {monthState.error !== null && (
        <ListStateMessage tone="error" title={monthState.error} hint="Elige otro mes." />
      )}

      {monthState.error === null && (
        <>
          {loading && <Skeleton className="h-14 w-full" />}
          {data && (
            <BusyRegion busy={updating}>
              <StatStrip
                aria-label={`Total de ${BUSINESS_LINE_LABELS[line]}`}
                data-testid="cifras-bobinas"
                className={
                  data.totals.closingValuePen === null
                    ? 'sm:grid-cols-3 lg:grid-cols-3'
                    : 'sm:grid-cols-4 lg:grid-cols-4'
                }
              >
                <Stat label="Saldo inicio (kg)" hint="al primer día del mes">
                  {formatKg(data.totals.openingKg, null)}
                </Stat>
                <Stat label="Peso de alta (kg)">{formatKg(data.totals.weightKg, null)}</Stat>
                <Stat label="Saldo fin (kg)" hint="al último día del mes">
                  {formatKg(data.totals.closingKg, null)}
                </Stat>
                {data.totals.closingValuePen !== null && (
                  <Stat label="Valor fin de mes">{formatMoney(data.totals.closingValuePen)}</Stat>
                )}
              </StatStrip>
            </BusyRegion>
          )}

          <Input
            type="search"
            aria-label="Buscar en el reporte"
            placeholder="Buscar bobina, tipo o color"
            className="h-8 max-w-xs"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
            }}
          />

          <MonthTable
            title="Selladas"
            film="SEALED"
            section={data?.sealed}
            emptyText="No había bobinas selladas al final de ese mes"
            search={searchText}
            onClearSearch={() => {
              setSearchText('');
            }}
            query={query}
            updating={updating}
          />
          {/* Si el reporte no cargó, el error y «Reintentar» van una sola vez, en la primera
              tabla; la segunda no se pinta. */}
          {!report.isError && (
            <MonthTable
              title="Abiertas"
              film="OPENED"
              section={data?.opened}
              emptyText="No había bobinas abiertas al final de ese mes"
              search={searchText}
              onClearSearch={() => {
                setSearchText('');
              }}
              query={query}
              updating={updating}
            />
          )}
          {data && (
            <BusyRegion busy={updating}>
              <MonthSummary report={data} />
            </BusyRegion>
          )}
        </>
      )}
    </RoleGate>
  );
}

/**
 * D-355: lo que las tablas no listan y el cuadre del mes. El cuadre usa los totales de **todas**
 * las bobinas del mes (listadas o no): inicio + altas − salidas = cierre. Lo consumido por una
 * terminada es su saldo al inicio más sus altas del mes (la madre de un partido o de un corte
 * «consumió» lo que pasó a sus hijas).
 */
function MonthSummary({ report }: { report: CoilMonthReportDto }) {
  const { finished, annulledWithOpening, flow } = report;
  return (
    <section aria-label="Resumen del mes" className="space-y-1 text-sm" data-testid="resumen-mes">
      {finished.count > 0 && (
        <p>
          {finished.count}{' '}
          {finished.count === 1 ? 'bobina terminada o agotada' : 'bobinas terminadas o agotadas'} en
          el mes, no listadas: {formatKg(finished.consumedKg)} consumidos.
        </p>
      )}
      {annulledWithOpening.count > 0 && (
        <p>
          {annulledWithOpening.count} {annulledWithOpening.count === 1 ? 'anulada' : 'anuladas'} con
          saldo al inicio: {formatKg(annulledWithOpening.openingKg)}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Saldo inicio {formatKg(flow.openingKg)} + altas {formatKg(flow.entriesKg)} − salidas{' '}
        {formatKg(flow.exitsKg)} = saldo fin de mes {formatKg(flow.closingKg)}.
      </p>
    </section>
  );
}

/** Una de las dos tablas del reporte, con su propio orden por columna (D-323) y su subtotal. */
function MonthTable({
  title,
  film,
  section,
  emptyText,
  search,
  onClearSearch,
  query,
  updating,
}: {
  title: string;
  film: CoilFilmState;
  section: CoilMonthReportSectionDto | undefined;
  emptyText: string;
  search: string;
  onClearSearch: () => void;
  query: { isPending: boolean; isError: boolean; isSuccess: boolean; refetch: () => unknown };
  updating: boolean;
}) {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<string>(film === 'SEALED' ? 'sellada' : 'abierta');
  const rows = section?.rows ?? [];
  const tableColumns = columns(film, section);
  // El contador sigue a la búsqueda: «2 de 5 bobinas» mientras filtra.
  const shown = filterReportRows(rows, tableColumns, search).length;

  return (
    <section aria-label={`Bobinas ${title.toLowerCase()}`} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {section && (
          <p className="text-xs text-muted-foreground" data-testid="contador-bobinas">
            {shown === rows.length ? '' : `${String(shown)} de `}
            {rows.length} {rows.length === 1 ? 'bobina' : 'bobinas'}
          </p>
        )}
      </div>
      <ReportTable
        testId={film === 'SEALED' ? 'tabla-selladas' : 'tabla-abiertas'}
        rowTestId="fila-bobina"
        columns={tableColumns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={sort}
        onSort={toggleSort}
        search={search}
        footerLabel={({ length: n }) =>
          `Subtotal ${title} · ${n === 1 ? '1 bobina' : `${String(n)} bobinas`}`
        }
        query={query}
        updating={updating}
        emptyTitle={emptyText}
        noResultsTitle={`Ninguna bobina ${title.toLowerCase().slice(0, -1)} coincide con «${search.trim()}»`}
        onClearSearch={onClearSearch}
        errorTitle="No se pudo cargar el reporte"
      />
    </section>
  );
}

function columns(
  film: CoilFilmState,
  section: CoilMonthReportSectionDto | undefined,
): ReportColumn<CoilMonthReportRowDto>[] {
  const showsCost = section !== undefined && section.totals.closingValuePen !== null;
  // Sin búsqueda, el subtotal del API; con búsqueda, el de las bobinas a la vista.
  const total = (rows: readonly CoilMonthReportRowDto[]) =>
    section && allRows(rows, section.rows)
      ? {
          openingKg: toDecimal(section.totals.openingKg),
          weightKg: toDecimal(section.totals.weightKg),
          closingKg: toDecimal(section.totals.closingKg),
          closingValuePen:
            section.totals.closingValuePen === null
              ? null
              : toDecimal(section.totals.closingValuePen),
        }
      : coilMonthTotalsOf(rows);
  const state = (r: CoilMonthReportRowDto) => coilStateLabel({ status: r.status, film });
  const base: ReportColumn<CoilMonthReportRowDto>[] = [
    {
      key: 'code',
      header: 'Bobina',
      cell: (r) => (
        <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/bobinas/${r.id}`}>
          {r.code}
        </Link>
      ),
      sortValue: { text: (r) => r.code },
      searchText: (r) => r.code,
    },
    {
      key: 'type',
      header: 'Tipo',
      cell: (r) => r.typeKey,
      sortValue: { text: (r) => r.typeKey },
      searchText: (r) => r.typeKey,
    },
    {
      key: 'line',
      header: 'Línea',
      className: 'hidden md:table-cell',
      cell: (r) => BUSINESS_LINE_LABELS[r.businessLine],
      sortValue: { text: (r) => BUSINESS_LINE_LABELS[r.businessLine] },
    },
    {
      key: 'color',
      header: 'Color',
      cell: (r) => r.colorName ?? '—',
      sortValue: { text: (r) => r.colorName ?? '' },
      searchText: (r) => r.colorName ?? '',
    },
    {
      key: 'width',
      header: 'Ancho (mm)',
      align: 'right',
      cell: (r) => formatQty(r.widthMm),
      sortValue: { decimal: (r) => r.widthMm },
    },
    {
      key: 'opening',
      header: 'Saldo inicio (kg)',
      align: 'right',
      cell: (r) => formatKg(r.openingKg, null),
      sortValue: { decimal: (r) => r.openingKg },
      total: (rows) => formatKg(total(rows).openingKg, null),
    },
    {
      key: 'weight',
      header: 'Peso de alta (kg)',
      align: 'right',
      cell: (r) => formatKg(r.weightKg, null),
      sortValue: { decimal: (r) => r.weightKg },
      total: (rows) => formatKg(total(rows).weightKg, null),
    },
    {
      key: 'closing',
      header: 'Saldo fin (kg)',
      align: 'right',
      cell: (r) => formatKg(r.closingKg, null),
      sortValue: { decimal: (r) => r.closingKg },
      total: (rows) => formatKg(total(rows).closingKg, null),
    },
  ];
  const cost: ReportColumn<CoilMonthReportRowDto>[] = showsCost
    ? [
        {
          key: 'cost',
          header: 'Costo/kg (S/)',
          align: 'right',
          className: 'hidden lg:table-cell',
          // P-14: costo/kg a 4 decimales, la escala con la que se guarda.
          cell: (r) => (r.unitCostPerKg === null ? '—' : formatAmount(r.unitCostPerKg, 4)),
          sortValue: { decimal: (r) => r.unitCostPerKg ?? '' },
        },
        {
          key: 'value',
          header: 'Valor fin (S/)',
          align: 'right',
          cell: (r) => (r.closingValuePen === null ? '—' : formatAmount(r.closingValuePen)),
          sortValue: { decimal: (r) => r.closingValuePen ?? '' },
          total: (rows) => {
            const value = total(rows).closingValuePen;
            return value === null ? '—' : formatAmount(value);
          },
        },
      ]
    : [];
  return [
    ...base,
    ...cost,
    {
      key: 'status',
      header: 'Estado',
      cell: state,
      sortValue: { text: state },
      searchText: state,
    },
  ];
}
