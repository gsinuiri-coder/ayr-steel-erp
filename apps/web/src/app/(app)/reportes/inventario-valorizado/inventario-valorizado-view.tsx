'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousInScope } from '@/lib/report-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_BUSINESS_LINES,
  COIL_STATUS_LABELS,
  INVENTORY_VALUATION_LINES,
  coilGroupLabel,
  Role,
  type InventoryValuationCoilGroupDto,
  type InventoryValuationDto,
  type InventoryValuationProductDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import {
  formatAmount,
  formatDate,
  formatKg,
  formatMoney,
  formatQty,
  formatQtyAsIs,
  formatUnitQty,
} from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { ReportHeader } from '@/components/reports/report-header';
import {
  BusyRegion,
  DETAIL_ROW_CLASSNAME,
  ReportTable,
  type ReportColumn,
} from '@/components/reports/report-table';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { sumDecimal } from '@/lib/report-table';
import { allRows } from '@/lib/report-totals';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
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
import { LINK_CLASSNAME, cn } from '@/lib/utils';

/**
 * Inventario valorizado a hoy (RF-S4a/M1). **Solo administrador**: cada fila lleva costo.
 *
 * Las bobinas se agrupan por línea / espesor / color comercial (D-272; sin color, por tipo de
 * acabado), que es como se mira el inventario cuando la pregunta es cuánto vale. Debajo del
 * color va el detalle por acabado —que es donde vive el RAL (D-270)— y cada grupo se abre a
 * sus bobinas. No es el mismo
 * corte que `/inventario`, que agrupa por `typeKey` (acabado + espesor, sin color) para
 * responder qué hay disponible para vender.
 *
 * cc32 (corte 2): con la plantilla de reportes —«Cómo se calcula», tablas con orden, búsqueda,
 * detalle con chevron y total al pie—. Sigue «a hoy», sin selector de periodo. Lo que se le pide
 * al API no cambia.
 */

/**
 * P-14: el costo promedio (por kilo o por unidad) se muestra a 4 decimales, la escala con la
 * que se guarda; a 2, el costo × la cantidad no reproducía el valor de la fila.
 */
const COST_DECIMALS = 4;

/**
 * cc23 (D-391, D-393): las líneas con inventario, con «Todas» primera y por defecto. cc32: el
 * orden de las dos tablas sobrevive al cambio de pestaña.
 */
const LINE_TABS: LineTabsConfig = {
  lines: INVENTORY_VALUATION_LINES,
  includeAll: true,
  keep: ['sort', 'dir', 'psort', 'pdir'],
};

export function InventarioValorizadoView() {
  const { tab, line, select } = useLineTab(LINE_TABS);
  const [url, setUrl] = useUrlState({ search: '' });
  const [sort, toggleSort] = useSort<string>();
  // La tabla de productos ordena con su propio prefijo: las dos tablas están en la misma URL.
  const [productSort, toggleProductSort] = useSort<string>('p');
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  // D-391: kilos en las líneas con bobinas; unidades en Coberturas (UPVC) y Reventa, que no
  // tienen bobinas propias (la bobina de reventa vive en la línea que la compró, D-116).
  // «A hoy», sin periodo: el alcance es el reporte y su pestaña, y es toda la clave. Al cambiar de
  // pestaña no se muestran las filas de la otra línea: se espera con el esqueleto
  // (`keepPreviousInScope`).
  const scope = ['report', 'inventory-valuation', line ?? 'todas'];
  const report = useQuery({
    queryKey: scope,
    queryFn: () =>
      api<InventoryValuationDto>(
        line === undefined
          ? '/reports/inventory-valuation'
          : `/reports/inventory-valuation?businessLine=${line}`,
      ),
    placeholderData: keepPreviousInScope<InventoryValuationDto>(scope),
  });
  const data = report.data;
  const updating = report.isPlaceholderData;
  // cc23, autorrevisión P3-10: si una bobina con saldo tuviera otra línea (la regla vive en la
  // aplicación, no en la base), su valor está en el «Total» y la tabla se muestra igual.
  const hasCoils =
    line === undefined || COIL_BUSINESS_LINES.includes(line) || (data?.coilGroups.length ?? 0) > 0;
  const query = {
    isPending: report.isPending,
    isError: report.isError,
    isSuccess: data !== undefined,
    refetch: report.refetch,
  };
  const clearSearch = () => {
    setSearchText('');
  };
  const coilCount = data?.coilGroups.reduce((n, g) => n + g.coilCount, 0) ?? 0;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <ReportHeader
        title="Inventario valorizado"
        subtitle={
          data
            ? `Saldo y costo promedio al ${formatDate(data.asOf)}.`
            : 'Saldo de kardex por su costo promedio ponderado.'
        }
        howItWorks={
          <>
            <p>
              Saldo de kardex a hoy, valorizado a su costo promedio ponderado. Las bobinas se
              agrupan por línea, espesor y color comercial (sin color, por tipo de acabado); debajo
              del color va el detalle por acabado, con su RAL. Abre un grupo con la flecha para ver
              sus bobinas.
            </p>
            <p>
              Una bobina con saldo que no está abierta es una anomalía (al cerrarla se liquida el
              remanente): se marca en rojo en vez de ocultarla, para que el total cuadre con el
              kardex.
            </p>
            <p>
              El costo promedio va a 4 decimales, la escala con la que se guarda. El costo por kilo
              de un grupo es su valor entre sus kilos, no el promedio de los promedios.
            </p>
            <p>
              El total al pie suma las filas de la tabla (con la búsqueda aplicada), con los valores
              completos y redondeado al final.
            </p>
          </>
        }
        actions={
          // Descarga directa contra el API (patrón D-149): el archivo sale del mismo DTO que esta
          // pantalla. cc39 (D-580, reemplaza a D-396): el Excel de la pestaña que se ve.
          <HeaderActions
            primary={['xlsx']}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: `/api/reports/inventory-valuation/xlsx${line === undefined ? '' : `?businessLine=${line}`}`,
              },
            ]}
          />
        }
      />

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {report.isPending && <Skeleton className="h-14 w-full" />}
      {data && hasCoils && (
        <BusyRegion busy={updating}>
          <StatStrip className="sm:grid-cols-2 lg:grid-cols-4" data-testid="cifras-inventario">
            <Stat
              label="Bobinas"
              hint={coilCount === 1 ? '1 bobina' : `${String(coilCount)} bobinas`}
            >
              {formatMoney(data.totals.coilValuePen)}
            </Stat>
            <Stat label="Bobinas (kg)">{formatKg(data.totals.coilQtyKg, null)}</Stat>
            <Stat
              label="Productos"
              hint={
                data.products.length === 1
                  ? '1 producto'
                  : `${String(data.products.length)} productos`
              }
            >
              {formatMoney(data.totals.productValuePen)}
            </Stat>
            <Stat label="Total">{formatMoney(data.totals.totalValuePen)}</Stat>
          </StatStrip>
        </BusyRegion>
      )}
      {data && !hasCoils && (
        <BusyRegion busy={updating}>
          <StatStrip className="sm:grid-cols-2 lg:grid-cols-2" data-testid="cifras-inventario">
            <Stat label="Productos con stock">{data.products.length}</Stat>
            <Stat label="Total">{formatMoney(data.totals.totalValuePen)}</Stat>
          </StatStrip>
        </BusyRegion>
      )}

      <Input
        type="search"
        aria-label="Buscar en el reporte"
        placeholder="Buscar color, bobina, SKU o producto"
        className="h-8 max-w-xs"
        value={searchText}
        onChange={(e) => {
          setSearchText(e.target.value);
        }}
      />

      {hasCoils && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Bobinas con saldo</h2>
          <ReportTable
            testId="tabla-inventario-bobinas"
            rowTestId="grupo-bobinas"
            columns={coilColumns(data)}
            rows={data?.coilGroups ?? []}
            rowKey={(g) => g.key}
            sort={sort}
            onSort={toggleSort}
            search={searchText}
            updating={updating}
            detail={(g) => <CoilRows group={g} />}
            detailLabel={(g) => `${coilGroupLabel(g)} ${g.thicknessMm} mm`}
            footerLabel={({ length: n }) =>
              `Total · ${n === 1 ? '1 grupo' : `${String(n)} grupos`}`
            }
            query={query}
            emptyTitle="No hay bobinas con saldo"
            noResultsTitle={`Ningún grupo de bobinas coincide con «${searchText.trim()}»`}
            onClearSearch={clearSearch}
            errorTitle="No se pudo cargar el reporte"
          />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Productos con stock</h2>
        <ReportTable
          testId="tabla-inventario-productos"
          rowTestId="fila-producto"
          columns={productColumns(data)}
          rows={data?.products ?? []}
          rowKey={(p) => p.itemId}
          sort={productSort}
          onSort={toggleProductSort}
          search={searchText}
          updating={updating}
          footerLabel={({ length: n }) =>
            `Total · ${n === 1 ? '1 producto' : `${String(n)} productos`}`
          }
          query={query}
          emptyTitle="No hay productos con stock"
          noResultsTitle={`Ningún producto coincide con «${searchText.trim()}»`}
          onClearSearch={clearSearch}
          errorTitle="No se pudo cargar el reporte"
        />
      </section>

      {/* En la pestaña de una línea, la tabla repetiría la franja de arriba: solo en «Todas». */}
      {data && line === undefined && (
        <BusyRegion busy={updating} className="space-y-2">
          <h2 className="text-sm font-semibold">Totales por línea de negocio</h2>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Línea</TableHead>
                  <TableHead className="text-right">Bobinas (S/)</TableHead>
                  <TableHead className="text-right">Productos (S/)</TableHead>
                  <TableHead className="text-right">Total (S/)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.totalsByLine.map((t) => (
                  <TableRow key={t.businessLine}>
                    <TableCell>{BUSINESS_LINE_LABELS[t.businessLine]}</TableCell>
                    <TableCell className="text-right">{formatAmount(t.coilValuePen)}</TableCell>
                    <TableCell className="text-right">{formatAmount(t.productValuePen)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatAmount(t.totalValuePen)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Total general</TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatAmount(data.totals.coilValuePen)}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatAmount(data.totals.productValuePen)}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatAmount(data.totals.totalValuePen)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </BusyRegion>
      )}
    </RoleGate>
  );
}

/** El acabado con su nombre, y el RAL si lo tiene (D-270, D-272). */
function finishText(name: string, code: string, ral: string | null): string {
  return ral === null ? `${name} (${code})` : `${name} · RAL ${ral} (${code})`;
}

function coilColumns(
  data: InventoryValuationDto | undefined,
): ReportColumn<InventoryValuationCoilGroupDto>[] {
  const unfiltered = (rows: readonly InventoryValuationCoilGroupDto[]) =>
    data !== undefined && allRows(rows, data.coilGroups);
  return [
    {
      key: 'line',
      header: 'Línea',
      cell: (g) => BUSINESS_LINE_LABELS[g.businessLine],
      sortValue: { text: (g) => BUSINESS_LINE_LABELS[g.businessLine] },
      searchText: (g) => BUSINESS_LINE_LABELS[g.businessLine],
    },
    {
      key: 'thickness',
      header: 'Espesor (mm)',
      align: 'right',
      cell: (g) => formatQtyAsIs(g.thicknessMm),
      sortValue: { decimal: (g) => g.thicknessMm },
    },
    {
      key: 'color',
      header: 'Color',
      cell: (g) => (
        <>
          <div>{coilGroupLabel(g)}</div>
          {/* D-272: el RAL como detalle del color, sin abrir el grupo. */}
          {g.finishes.length > 0 && (
            <ul className="text-xs text-muted-foreground" aria-label="Detalle por acabado">
              {g.finishes.map((f) => (
                <li key={f.finishCode}>
                  {finishText(f.finishName, f.finishCode, f.ral)}: {formatKg(f.qtyKg)} ·{' '}
                  {formatMoney(f.totalValuePen)}
                </li>
              ))}
            </ul>
          )}
        </>
      ),
      sortValue: { text: (g) => coilGroupLabel(g) },
      searchText: (g) => [
        coilGroupLabel(g),
        ...g.finishes.flatMap((f) => [f.finishName, f.finishCode, f.ral ?? '']),
        ...g.coils.map((c) => c.code),
      ],
    },
    {
      key: 'count',
      header: 'Bobinas',
      align: 'right',
      cell: (g) => String(g.coilCount),
      sortValue: { decimal: (g) => String(g.coilCount) },
      total: (rows) => String(rows.reduce((n, g) => n + g.coilCount, 0)),
    },
    {
      key: 'qty',
      header: 'Saldo (kg)',
      align: 'right',
      cell: (g) => formatKg(g.qtyKg, null),
      sortValue: { decimal: (g) => g.qtyKg },
      total: (rows) =>
        formatKg(
          unfiltered(rows) && data ? data.totals.coilQtyKg : sumDecimal(rows, (g) => g.qtyKg),
          null,
        ),
    },
    {
      key: 'cost',
      header: 'Costo/kg (S/)',
      align: 'right',
      cell: (g) => formatAmount(g.avgCostPen, COST_DECIMALS),
      sortValue: { decimal: (g) => g.avgCostPen },
    },
    {
      key: 'value',
      header: 'Valor (S/)',
      align: 'right',
      cell: (g) => <span className="font-medium">{formatAmount(g.totalValuePen)}</span>,
      sortValue: { decimal: (g) => g.totalValuePen },
      total: (rows) =>
        formatAmount(
          unfiltered(rows) && data
            ? data.totals.coilValuePen
            : sumDecimal(rows, (g) => g.totalValuePen),
        ),
    },
  ];
}

/**
 * Las bobinas del grupo. El detalle comparte la tabla del grupo, así que solo usa las columnas
 * cuyo encabezado significa lo mismo para una bobina que para su grupo: saldo, costo/kg y valor.
 * Lo que es propio de la bobina —ancho, acabado, fecha de alta— va dentro de la primera celda y
 * rotulado, no repartido por las columnas de la izquierda (un dato correcto debajo de un rótulo
 * que decía otra cosa).
 */
function CoilRows({ group }: { group: InventoryValuationCoilGroupDto }) {
  return (
    <>
      {group.coils.map((coil) => (
        <TableRow key={coil.id} className={DETAIL_ROW_CLASSNAME} data-testid="bobina-inventario">
          <TableCell className="pl-8" colSpan={4}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link className={cn(LINK_CLASSNAME, 'font-mono')} href={`/bobinas/${coil.id}`}>
                {coil.code}
              </Link>
              <span className="text-muted-foreground">Ancho {formatQty(coil.widthMm, 'mm')}</span>
              <span className="text-muted-foreground">
                {/* cc39 (D-582): el nombre del acabado viene en la bobina, del API. */}
                {finishText(coil.finishName, coil.finishCode, coil.ral)}
              </span>
              <span className="text-muted-foreground">Alta {formatDate(coil.operationDate)}</span>
              {/*
                El estado solo se muestra cuando **no** es «Abierta»: una bobina con saldo que no
                está abierta es una anomalía (D-164 liquida el remanente al cerrar) y el reporte la
                delata en vez de filtrarla.
              */}
              {coil.status !== 'OPEN' && (
                <Badge variant="destructive">{COIL_STATUS_LABELS[coil.status]}</Badge>
              )}
            </div>
          </TableCell>
          <TableCell className="text-right">{formatKg(coil.qtyKg, null)}</TableCell>
          <TableCell className="text-right">
            {formatAmount(coil.avgCostPen, COST_DECIMALS)}
          </TableCell>
          <TableCell className="text-right">{formatAmount(coil.totalValuePen)}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

function productColumns(
  data: InventoryValuationDto | undefined,
): ReportColumn<InventoryValuationProductDto>[] {
  return [
    {
      key: 'sku',
      header: 'SKU',
      cell: (p) => <span className="font-mono">{p.sku}</span>,
      sortValue: { text: (p) => p.sku },
      searchText: (p) => p.sku,
    },
    {
      key: 'name',
      header: 'Descripción',
      cell: (p) => p.name,
      sortValue: { text: (p) => p.name },
      searchText: (p) => p.name,
    },
    {
      key: 'line',
      header: 'Línea',
      className: 'hidden md:table-cell',
      cell: (p) => BUSINESS_LINE_LABELS[p.businessLine],
      sortValue: { text: (p) => BUSINESS_LINE_LABELS[p.businessLine] },
      searchText: (p) => BUSINESS_LINE_LABELS[p.businessLine],
    },
    {
      // La unidad cambia de un producto a otro: va en la celda.
      key: 'qty',
      header: 'Cantidad',
      align: 'right',
      cell: (p) => formatUnitQty(p.qty, p.unit),
      sortValue: { decimal: (p) => p.qty },
    },
    {
      key: 'cost',
      header: 'Costo unitario (S/)',
      align: 'right',
      cell: (p) => formatAmount(p.avgCostPen, COST_DECIMALS),
      sortValue: { decimal: (p) => p.avgCostPen },
    },
    {
      key: 'value',
      header: 'Valor (S/)',
      align: 'right',
      cell: (p) => formatAmount(p.totalValuePen),
      sortValue: { decimal: (p) => p.totalValuePen },
      total: (rows) =>
        formatAmount(
          data && allRows(rows, data.products)
            ? data.totals.productValuePen
            : sumDecimal(rows, (p) => p.totalValuePen),
        ),
    },
  ];
}
