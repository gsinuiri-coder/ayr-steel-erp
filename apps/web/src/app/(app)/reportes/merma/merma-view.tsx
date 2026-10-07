'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  COIL_REPORT_LINES,
  COIL_STATUS_LABELS,
  MISSING_THEORETICAL_LABELS,
  Role,
  type CoilWasteDto,
  type CoilWasteLine,
  type CoilWasteRowDto,
  toDecimal,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
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
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDate, formatKg, formatQty } from '@/lib/format';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { allRows, wasteTotalsOf, type WasteTotals } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME, cn } from '@/lib/utils';

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433). Merma por bobina en un rango. **Solo administrador**
 * (D-426), sin Excel.
 *
 * Entran las bobinas con producción en el rango, con las cifras del kardex del rango. La merma es
 * (consumido − teórico) + despunte + ajuste de cierre, sobre el teórico, contra el 1 % estándar.
 * Nada se estima: una bobina con una producción sin teórico atribuible lo declara y queda sin
 * porcentaje.
 *
 * cc32 (corte 2): con la plantilla de reportes —periodo único en la URL, «Cómo se calcula», tabla
 * con orden, búsqueda, detalle con chevron y total al pie—. Lo que se le pide al API no cambia.
 */
export function MermaView() {
  const periodState = useReportPeriod();
  const { period, valid } = periodState;
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea de este reporte.
  const line = tab as CoilWasteLine;
  const [url, setUrl] = useUrlState({ search: '' });
  const [sort, toggleSort] = useSort<string>();
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

  // El alcance es el reporte y su pestaña; el periodo va después (`keepPreviousInScope`).
  const scope = ['report', 'coil-waste', line];
  const report = useQuery({
    queryKey: [...scope, period.from, period.to],
    queryFn: () =>
      api<CoilWasteDto>(
        `/reports/coil-waste?from=${period.from}&to=${period.to}&businessLine=${line}`,
      ),
    enabled: valid,
    // Al cambiar de periodo, el dato anterior queda a la vista (atenuado) mientras carga; al
    // cambiar de pestaña, no: sería mostrar otra línea con el nombre de esta.
    placeholderData: keepPreviousInScope<CoilWasteDto>(scope),
  });
  const data = valid ? report.data : undefined;
  const updating = valid && report.isPlaceholderData;
  const loading = !periodState.complete || (valid && report.isPending);
  const missingCount = data ? data.totals.coilCount - data.totals.comparableCoilCount : 0;
  // En Drywall, lo que sale al cerrar la OP es la merma de proceso (D-057), no un despunte.
  const trimLabel = line === BusinessLine.DRYWALL ? 'Merma de proceso' : 'Despunte';

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <ReportHeader
        title="Merma por bobina"
        subtitle={`${BUSINESS_LINE_LABELS[line]}. Merma sobre el estándar de cada bobina, con el kardex del periodo.`}
        howItWorks={
          <>
            <p>
              {BUSINESS_LINE_LABELS[line]}. Bobinas con producción, {trimLabel.toLowerCase()} o
              ajuste de cierre en el rango, con los movimientos de kardex del rango. Merma =
              (consumido − teórico) + {trimLabel.toLowerCase()} + ajuste de cierre.
            </p>
            {/* D-434: el teórico ya lleva el 1 % normal (D-165); el porcentaje es lo que lo pasa. */}
            <p data-testid="aviso-estandar">
              El teórico ya incluye el 1 % de merma estándar, así que la merma y el porcentaje son
              lo que queda por encima del estándar. Hasta el {data?.standardPct ?? '1.00'} % es
              normal (la tolerancia de producción); más que eso se marca en rojo.
            </p>
            <p>
              Una bobina con una producción sin teórico atribuible no tiene merma calculada y queda
              fuera del teórico, la diferencia, la merma y el porcentaje del total. Ábrela con la
              flecha para ver el motivo.
              {missingCount > 0 && (
                <span data-testid="aviso-sin-teorico">
                  {' '}
                  {missingCount === 1
                    ? 'En este periodo, 1 bobina está así.'
                    : `En este periodo, ${String(missingCount)} bobinas están así.`}
                </span>
              )}
            </p>
            <p>
              La merma manual («Otra merma») es informativa: no suma a la merma. El total al pie
              suma las filas de la tabla (con la búsqueda aplicada), con los valores completos y
              redondeado al final.
            </p>
          </>
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
              <StatStrip className="sm:grid-cols-3 lg:grid-cols-6" data-testid="cifras-merma">
                <Stat label="Bobinas">{data.totals.coilCount}</Stat>
                <Stat label="Consumido (kg)">{formatKg(data.totals.consumedKg, null)}</Stat>
                <Stat
                  label="Teórico (kg)"
                  hint={
                    missingCount > 0
                      ? `solo ${String(data.totals.comparableCoilCount)} de ${String(data.totals.coilCount)} bobinas`
                      : undefined
                  }
                >
                  {formatKg(data.totals.theoreticalKg, null)}
                </Stat>
                <Stat label={`${trimLabel} (kg)`}>{formatKg(data.totals.trimKg, null)}</Stat>
                <Stat label="Merma (kg)" hint="sobre el estándar">
                  {formatKg(data.totals.wasteKg, null)}
                </Stat>
                <Stat label="Merma %" hint={`normal hasta ${data.standardPct} %`}>
                  <Pct pct={data.totals.wastePct} over={data.totals.overStandard} />
                </Stat>
              </StatStrip>
            </BusyRegion>
          )}

          <Input
            type="search"
            aria-label="Buscar en el reporte"
            placeholder="Buscar bobina, tipo, color u orden"
            className="h-8 max-w-xs"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
            }}
          />

          <ReportTable
            testId="tabla-merma"
            rowTestId="merma-bobina"
            columns={columns(trimLabel, data)}
            rows={data?.rows ?? []}
            rowKey={(r) => r.coilId}
            sort={sort}
            onSort={toggleSort}
            search={searchText}
            updating={updating}
            detail={(r) => <ProductionRows row={r} />}
            detailLabel={(r) => r.code}
            footerLabel={({ length: n }) =>
              `Total · ${n === 1 ? '1 bobina' : `${String(n)} bobinas`}`
            }
            query={{
              isPending: loading,
              isError: report.isError,
              isSuccess: data !== undefined,
              refetch: report.refetch,
            }}
            emptyTitle={`No hay bobinas de esta línea con producción, ${trimLabel.toLowerCase()} o ajuste de cierre en ese periodo`}
            noResultsTitle={`Ninguna bobina coincide con «${searchText.trim()}»`}
            onClearSearch={() => {
              setSearchText('');
            }}
            errorTitle="No se pudo cargar el reporte"
          />
        </>
      )}
    </RoleGate>
  );
}

/** El total al pie: el del API sin búsqueda; con búsqueda, el de las bobinas a la vista. */
function totalsFor(rows: readonly CoilWasteRowDto[], data: CoilWasteDto | undefined): WasteTotals {
  if (data && allRows(rows, data.rows)) {
    const t = data.totals;
    return {
      coilCount: t.coilCount,
      consumedKg: toDecimal(t.consumedKg),
      trimKg: toDecimal(t.trimKg),
      closeAdjustmentKg: toDecimal(t.closeAdjustmentKg),
      manualScrapKg: toDecimal(t.manualScrapKg),
      comparableCoilCount: t.comparableCoilCount,
      comparableConsumedKg: toDecimal(t.comparableConsumedKg),
      theoreticalKg: toDecimal(t.theoreticalKg),
      differenceKg: toDecimal(t.differenceKg),
      wasteKg: toDecimal(t.wasteKg),
      wastePct: t.wastePct,
      overStandard: t.overStandard,
    };
  }
  return wasteTotalsOf(rows, data?.standardPct ?? '1.00');
}

function columns(
  trimLabel: string,
  data: CoilWasteDto | undefined,
): ReportColumn<CoilWasteRowDto>[] {
  const total = (rows: readonly CoilWasteRowDto[]) => totalsFor(rows, data);
  return [
    {
      key: 'code',
      header: 'Bobina',
      cell: (r) => (
        <span className="inline-flex flex-col">
          <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/bobinas/${r.coilId}`}>
            {r.code}
          </Link>
          <span className="text-xs text-muted-foreground">
            {r.typeKey}
            {r.colorName ? ` · ${r.colorName}` : ''} · ancho {formatQty(r.widthMm, 'mm')}
          </span>
          <ToleranceBadge row={r} />
          {r.productions.some((p) => p.missingTheoretical !== null) && (
            <Badge variant="secondary" className="mt-1">
              Sin teórico atribuible
            </Badge>
          )}
        </span>
      ),
      sortValue: { text: (r) => r.code },
      searchText: (r) => [
        r.code,
        r.typeKey,
        r.colorName ?? '',
        ...r.productions.map((p) => p.productionOrderCode ?? ''),
      ],
    },
    {
      key: 'status',
      header: 'Estado',
      cell: (r) => COIL_STATUS_LABELS[r.status],
      sortValue: { text: (r) => COIL_STATUS_LABELS[r.status] },
      searchText: (r) => COIL_STATUS_LABELS[r.status],
    },
    {
      key: 'consumed',
      header: 'Consumido (kg)',
      align: 'right',
      cell: (r) => formatKg(r.consumedKg, null),
      sortValue: { decimal: (r) => r.consumedKg },
      total: (rows) => (
        <span data-testid="merma-total-consumido">{formatKg(total(rows).consumedKg, null)}</span>
      ),
    },
    {
      key: 'theoretical',
      header: 'Teórico (kg)',
      align: 'right',
      cell: (r) => kgOrDash(r.theoreticalKg),
      sortValue: { decimal: (r) => r.theoreticalKg ?? '' },
      total: (rows) => formatKg(total(rows).theoreticalKg, null),
    },
    {
      key: 'difference',
      header: 'Diferencia (kg)',
      align: 'right',
      cell: (r) => kgOrDash(r.differenceKg),
      sortValue: { decimal: (r) => r.differenceKg ?? '' },
      total: (rows) => formatKg(total(rows).differenceKg, null),
    },
    {
      key: 'trim',
      header: `${trimLabel} (kg)`,
      align: 'right',
      cell: (r) => formatKg(r.trimKg, null),
      sortValue: { decimal: (r) => r.trimKg },
      total: (rows) => formatKg(total(rows).trimKg, null),
    },
    {
      key: 'adjustment',
      header: 'Ajuste de cierre (kg)',
      align: 'right',
      cell: (r) => formatKg(r.closeAdjustmentKg, null),
      sortValue: { decimal: (r) => r.closeAdjustmentKg },
      total: (rows) => formatKg(total(rows).closeAdjustmentKg, null),
    },
    {
      key: 'waste',
      header: 'Merma (kg)',
      align: 'right',
      cell: (r) => <span className="font-medium">{kgOrDash(r.wasteKg)}</span>,
      sortValue: { decimal: (r) => r.wasteKg ?? '' },
      total: (rows) => formatKg(total(rows).wasteKg, null),
    },
    {
      key: 'pct',
      header: 'Merma %',
      align: 'right',
      cell: (r) => <Pct pct={r.wastePct} over={r.overStandard} />,
      sortValue: { decimal: (r) => r.wastePct ?? '' },
      total: (rows) => {
        const t = total(rows);
        return <Pct pct={t.wastePct} over={t.overStandard} />;
      },
    },
    {
      key: 'manual',
      header: 'Otra merma (kg)',
      align: 'right',
      className: 'text-muted-foreground',
      cell: (r) => formatKg(r.manualScrapKg, null),
      sortValue: { decimal: (r) => r.manualScrapKg },
      total: (rows) => formatKg(total(rows).manualScrapKg, null),
    },
  ];
}

/** Cuántas producciones de la bobina se confirmaron fuera de tolerancia (D-388/D-389). */
function ToleranceBadge({ row }: { row: CoilWasteRowDto }) {
  const flagged = row.productions.filter((p) => p.outOfTolerance !== null).length;
  if (flagged === 0) return null;
  return (
    <Badge variant="warning" className="mt-1">
      Fuera de tolerancia{flagged > 1 ? ` (${String(flagged)})` : ''}
    </Badge>
  );
}

/** Las producciones de la bobina en el periodo, alineadas con las columnas. */
function ProductionRows({ row }: { row: CoilWasteRowDto }) {
  return (
    <>
      {row.productions.map((p, i) => (
        <TableRow
          key={p.reportId ?? `sin-reporte-${String(i)}`}
          className={DETAIL_ROW_CLASSNAME}
          data-testid="merma-produccion"
        >
          <TableCell className="pl-8">
            {p.productionOrderId && p.productionOrderCode ? (
              <Link
                className={cn(LINK_CLASSNAME, 'font-mono')}
                href={`/produccion/${p.productionOrderId}`}
              >
                {p.productionOrderCode}
              </Link>
            ) : (
              <span className="text-muted-foreground">Sin orden</span>
            )}
          </TableCell>
          <TableCell>{formatDate(p.operationDate)}</TableCell>
          <TableCell className="text-right">{formatKg(p.consumedKg, null)}</TableCell>
          <TableCell className="text-right">{kgOrDash(p.theoreticalKg)}</TableCell>
          <TableCell colSpan={COLUMN_COUNT - 4}>
            {p.outOfTolerance && (
              <span className="flex flex-wrap items-center gap-1">
                <Badge variant="warning">Fuera de tolerancia</Badge>
                {p.outOfTolerance.label} ({p.outOfTolerance.excessPct} %)
              </span>
            )}
            {p.missingTheoretical && (
              <span className="text-muted-foreground">
                {MISSING_THEORETICAL_LABELS[p.missingTheoretical]}
              </span>
            )}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/** D-434: el porcentaje, en rojo solo si pasa la tolerancia del 1 % sobre el estándar. */
function Pct({ pct, over }: { pct: string | null; over: boolean }) {
  if (pct === null) return <>—</>;
  return over ? <Badge variant="destructive">{pct} %</Badge> : <span>{pct} %</span>;
}

function kgOrDash(value: string | null): string {
  return value === null ? '—' : formatKg(value, null);
}

/** cc25 (D-424): Coberturas Aluzinc y Drywall, sin «Todas»; el periodo y el orden sobreviven. */
const LINE_TABS: LineTabsConfig = {
  lines: COIL_REPORT_LINES,
  includeAll: false,
  keep: ['from', 'to', 'sort', 'dir'],
};

/** Bobina, estado, las siete cifras y el porcentaje. */
const COLUMN_COUNT = 10;
