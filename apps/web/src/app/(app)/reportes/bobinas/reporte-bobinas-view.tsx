'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_REPORT_LINES,
  businessMonth,
  coilStateLabel,
  Role,
  type CoilFilmState,
  type CoilMonthReportDto,
  type CoilMonthReportSectionDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { useUrlState } from '@/lib/use-url-state';
import { RoleGate } from '@/components/role-gate';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LINK_CLASSNAME } from '@/lib/utils';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

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
 */
/**
 * cc24 (D-408, D-418): Coberturas Aluzinc y Drywall, sin «Todas» (D-393), Aluzinc por defecto.
 * El mes sobrevive al cambio de pestaña.
 */
const LINE_TABS: LineTabsConfig = { lines: COIL_REPORT_LINES, includeAll: false, keep: ['mes'] };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function ReporteBobinasView() {
  // cc24 (D-408, D-418): la pestaña de línea y el mes van en la URL, para que refrescar y
  // retroceder vuelvan al mismo estado (criterio de D-401); el mes en curso no se escribe.
  const [url, setUrl] = useUrlState({ mes: businessMonth() });
  const month = MONTH.test(url.mes) ? url.mes : businessMonth();
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea con bobinas.
  const line = tab as (typeof COIL_REPORT_LINES)[number];
  const qs = `month=${month}&businessLine=${line}`;

  const report = useQuery({
    queryKey: ['report', 'coils', month, line],
    queryFn: () => api<CoilMonthReportDto>(`/reports/coils?${qs}`),
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Reporte mensual de bobinas</h1>
          <p className="text-xs text-muted-foreground">
            {report.data
              ? `Del ${formatDate(report.data.from)} al ${formatDate(report.data.to)}`
              : 'Saldo al inicio del mes y al cierre, por bobina.'}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="reporte-mes">Mes</Label>
            <Input
              id="reporte-mes"
              type="month"
              max={businessMonth()}
              value={month}
              onChange={(e) => {
                if (e.target.value) setUrl({ mes: e.target.value });
              }}
            />
          </div>
          {/* D-355: descargas directas contra el API (patrón D-149), del mismo mes que se ve.
              D-408/D-418: el PDF y el Excel siguen la pestaña. */}
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
        </div>
      </div>

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {report.data && (
        <StatStrip
          aria-label={`Total de ${BUSINESS_LINE_LABELS[line]}`}
          className={
            report.data.totals.closingValuePen === null
              ? 'sm:grid-cols-3 lg:grid-cols-3'
              : 'sm:grid-cols-4 lg:grid-cols-4'
          }
        >
          <Stat label="Saldo inicio de mes">{formatQty(report.data.totals.openingKg, 'kg')}</Stat>
          <Stat label="Peso de alta">{formatQty(report.data.totals.weightKg, 'kg')}</Stat>
          <Stat label="Saldo fin de mes">{formatQty(report.data.totals.closingKg, 'kg')}</Stat>
          {report.data.totals.closingValuePen !== null && (
            <Stat label="Valor fin de mes">{formatMoney(report.data.totals.closingValuePen)}</Stat>
          )}
        </StatStrip>
      )}

      {report.isPending && <Skeleton className="h-24 w-full" />}
      {report.isError && <p className="text-destructive">No se pudo cargar el reporte.</p>}
      {report.data && (
        <>
          <MonthTable
            title="Selladas"
            film="SEALED"
            section={report.data.sealed}
            emptyText="No había bobinas selladas al final de ese mes."
          />
          <MonthTable
            title="Abiertas"
            film="OPENED"
            section={report.data.opened}
            emptyText="No había bobinas abiertas al final de ese mes."
          />
          <MonthSummary report={report.data} />
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
          el mes, no listadas: {formatQty(finished.consumedKg, 'kg')} consumidos.
        </p>
      )}
      {annulledWithOpening.count > 0 && (
        <p>
          {annulledWithOpening.count} {annulledWithOpening.count === 1 ? 'anulada' : 'anuladas'} con
          saldo al inicio: {formatQty(annulledWithOpening.openingKg, 'kg')}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Saldo inicio {formatQty(flow.openingKg, 'kg')} + altas {formatQty(flow.entriesKg, 'kg')} −
        salidas {formatQty(flow.exitsKg, 'kg')} = saldo fin de mes {formatQty(flow.closingKg, 'kg')}
        .
      </p>
    </section>
  );
}

type SortKey =
  | 'code'
  | 'type'
  | 'line'
  | 'color'
  | 'width'
  | 'opening'
  | 'weight'
  | 'closing'
  | 'cost'
  | 'value'
  | 'status';

/** Una de las dos tablas del reporte, con su propio orden por columna (D-323) y su subtotal. */
function MonthTable({
  title,
  film,
  section,
  emptyText,
  note,
}: {
  title: string;
  film: CoilFilmState;
  section: CoilMonthReportSectionDto;
  emptyText: string;
  note?: string;
}) {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<SortKey>(film === 'SEALED' ? 'sellada' : 'abierta');
  const showsCost = section.totals.closingValuePen !== null;
  const colSpan = showsCost ? 11 : 9;

  return (
    <section aria-label={`Bobinas ${title.toLowerCase()}`} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">
          {section.rows.length} {section.rows.length === 1 ? 'bobina' : 'bobinas'}
          {note ? ` · ${note}` : ''}
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="code">
                Código
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="type">
                Tipo
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="line" className="hidden md:table-cell">
                Línea
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="color">
                Color
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="width"
                className="text-right"
                align="right"
              >
                Ancho
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="opening"
                className="text-right"
                align="right"
              >
                Saldo inicio mes (kg)
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="weight"
                className="text-right"
                align="right"
              >
                Peso (kg)
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="closing"
                className="text-right"
                align="right"
              >
                Saldo fin de mes (kg)
              </SortHead>
              {showsCost && (
                <SortHead
                  sort={sort}
                  onSort={toggleSort}
                  k="cost"
                  className="hidden text-right lg:table-cell"
                  align="right"
                >
                  Costo/kg
                </SortHead>
              )}
              {showsCost && (
                <SortHead
                  sort={sort}
                  onSort={toggleSort}
                  k="value"
                  className="text-right"
                  align="right"
                >
                  Valor fin de mes
                </SortHead>
              )}
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
            {sortRows(section.rows, sort, {
              code: { text: (row) => row.code },
              type: { text: (row) => row.typeKey },
              line: { text: (row) => row.businessLine },
              color: { text: (row) => row.colorName ?? '' },
              width: { decimal: (row) => row.widthMm },
              opening: { decimal: (row) => row.openingKg },
              weight: { decimal: (row) => row.weightKg },
              closing: { decimal: (row) => row.closingKg },
              cost: { decimal: (row) => row.unitCostPerKg ?? '' },
              value: { decimal: (row) => row.closingValuePen ?? '' },
              status: { text: (row) => coilStateLabel({ status: row.status, film }) },
            }).map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono">
                  <Link className={LINK_CLASSNAME} href={`/bobinas/${row.id}`}>
                    {row.code}
                  </Link>
                </TableCell>
                <TableCell>{row.typeKey}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {BUSINESS_LINE_LABELS[row.businessLine]}
                </TableCell>
                <TableCell>{row.colorName ?? '—'}</TableCell>
                <TableCell className="text-right">{formatQty(row.widthMm, 'mm')}</TableCell>
                <TableCell className="text-right">{formatQty(row.openingKg)}</TableCell>
                <TableCell className="text-right">{formatQty(row.weightKg)}</TableCell>
                <TableCell className="text-right">{formatQty(row.closingKg)}</TableCell>
                {showsCost && (
                  <TableCell className="hidden text-right lg:table-cell">
                    {/* P-14: costo/kg a 4 decimales, la escala con la que se guarda. */}
                    {row.unitCostPerKg === null ? '—' : formatMoney(row.unitCostPerKg, 'PEN', 4)}
                  </TableCell>
                )}
                {showsCost && (
                  <TableCell className="text-right">
                    {row.closingValuePen === null ? '—' : formatMoney(row.closingValuePen)}
                  </TableCell>
                )}
                <TableCell>{coilStateLabel({ status: row.status, film })}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="font-medium">
                Subtotal {title}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.openingKg)}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.weightKg)}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.closingKg)}
              </TableCell>
              {showsCost && <TableCell className="hidden lg:table-cell" />}
              {showsCost && (
                <TableCell className="text-right font-medium">
                  {section.totals.closingValuePen === null
                    ? '—'
                    : formatMoney(section.totals.closingValuePen)}
                </TableCell>
              )}
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </section>
  );
}
