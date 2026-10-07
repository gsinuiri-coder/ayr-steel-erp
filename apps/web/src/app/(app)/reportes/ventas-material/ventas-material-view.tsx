'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
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
  businessToday,
  type SalesByMaterialDto,
  type SalesByMaterialLine,
  type SalesByProductDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
  type SalesMaterialRowDto,
} from '@ayr/shared';
import { FilterChip } from '@/components/filter-chip';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
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
import { formatDate, formatMoney, formatQty, unitSymbol } from '@/lib/format';
import {
  KARDEX_RANGE_LABELS,
  kardexCustomPatch,
  parseKardexRange,
  resolveKardexDates,
} from '@/lib/kardex-range';
import { useUrlState } from '@/lib/use-url-state';
import { cn, LINK_CLASSNAME } from '@/lib/utils';

/** Los presets de este reporte: sin «Todo», que no tiene sentido para un reporte de mes. */
const RANGES = ['month', 'prev'] as const;

/**
 * cc24 (D-406, D-407): una pestaña por línea, sin «Todas», Coberturas Aluzinc por defecto. Al
 * cambiar de pestaña sobrevive el rango; tipo, espesor y color son de la línea y se descartan.
 */
const LINE_TABS: LineTabsConfig = {
  lines: SALES_BY_MATERIAL_LINES,
  includeAll: false,
  keep: ['range', 'from', 'to'],
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
 */
export function VentasMaterialView() {
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea de este reporte.
  const line = tab as SalesByMaterialLine;
  const lineLabel = BUSINESS_LINE_LABELS[line];
  const kinds = KINDS_BY_LINE[line];
  // D-417: Coberturas (UPVC) y Reventa van por producto, sin bobina.
  const byProduct = SALES_BY_PRODUCT_LINES.includes(line);
  const [url, setUrl] = useUrlState({
    range: '',
    from: '',
    to: '',
    tipo: '',
    espesor: '',
    color: '',
  });
  const today = businessToday();
  const range = parseKardexRange(url.range);
  // «Todo» no se ofrece; si llega por URL, se lee como el mes en curso.
  const dates = resolveKardexDates(range === 'all' ? 'month' : range, url.from, url.to, today);
  const validRange = dates.from !== '' && dates.to !== '' && dates.from <= dates.to;
  const kind = (kinds as readonly string[]).includes(url.tipo)
    ? (url.tipo as SalesMaterialKind)
    : undefined;

  const base = `from=${dates.from}&to=${dates.to}&businessLine=${line}`;
  const filters = new URLSearchParams();
  if (kind !== undefined) filters.set('kind', kind);
  if (url.espesor !== '') filters.set('thicknessMm', url.espesor);
  if (url.color !== '') filters.set('color', url.color);
  const filterQs = filters.toString();
  const qs = filterQs === '' ? base : `${base}&${filterQs}`;

  const report = useQuery({
    queryKey: ['report', 'sales-by-material', qs],
    queryFn: () => api<SalesByMaterialDto>(`/reports/sales-by-material?${qs}`),
    enabled: validRange,
  });
  // Las opciones de espesor y color salen del rango sin filtrar (misma consulta sin filtros).
  const unfiltered = useQuery({
    queryKey: ['report', 'sales-by-material', base],
    queryFn: () => api<SalesByMaterialDto>(`/reports/sales-by-material?${base}`),
    enabled: validRange,
  });

  const options = useMemo(() => {
    const rows = unfiltered.data?.rows ?? [];
    const thicknesses = [...new Set(rows.map((r) => r.thicknessMm))].sort(
      (a, b) => Number(a) - Number(b),
    );
    const colors = [...new Set(rows.map((r) => r.colorLabel))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    return { thicknesses, colors };
  }, [unfiltered.data]);

  // D-370: el desglose se abre desde la fila; ya no hay un botón para todas las filas.
  const [selected, setSelected] = useState<SalesMaterialRowDto | null>(null);
  const data = report.data;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Ventas por material</h1>
          <p className="text-xs text-muted-foreground">
            {lineLabel}. Comprobantes emitidos en el rango, sin IGV;{' '}
            {byProduct
              ? // D-417 (autorrevisión de cc24, P2-1): sin bobina, el costo es el del despacho.
                'costo de kardex de los despachos que declaran el comprobante.'
              : 'peso real y costo de las bobinas que consumió la producción.'}
          </p>
        </div>
        {/* D-396 con el criterio de D-399: sin exportación por línea. El Excel de siempre es el
            de Coberturas Aluzinc y solo se ofrece en esa pestaña. */}
        {line === BusinessLine.METALLIC_ROOFING && (
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
        )}
      </div>

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2" role="group" aria-label="Rango de fechas">
          {RANGES.map((r) => (
            <FilterChip
              key={r}
              active={range === r || (r === 'month' && range === 'all')}
              onToggle={() => {
                setUrl({ range: r, from: '', to: '' });
              }}
            >
              {KARDEX_RANGE_LABELS[r]}
            </FilterChip>
          ))}
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Desde</span>
          <Input
            type="date"
            className="w-40"
            value={dates.from}
            onChange={(e) => {
              const value = e.target.value;
              setUrl((cur) => kardexCustomPatch('from', value, cur, dates));
            }}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Hasta</span>
          <Input
            type="date"
            className="w-40"
            value={dates.to}
            onChange={(e) => {
              const value = e.target.value;
              setUrl((cur) => kardexCustomPatch('to', value, cur, dates));
            }}
          />
        </label>
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
      </div>
      {!validRange && (
        <p className="text-xs text-destructive">La fecha «Desde» es posterior a «Hasta».</p>
      )}

      {/* C06: el aviso de los dos reportes, en palabras del dueño. No aplica a las pestañas por
          producto, cuyo costo es el mismo de «Ventas y margen» (D-417). */}
      {!byProduct && (
        <p className="text-xs text-muted-foreground" data-testid="aviso-costeo">
          {PROFIT_SOURCES_NOTICE}
        </p>
      )}

      {report.isPending && validRange && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {data?.products === null && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table data-testid="ventas-material">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="text-right">Espesor</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead className="text-right">ML vendido</TableHead>
                  <TableHead className="text-right">Peso teórico</TableHead>
                  <TableHead className="text-right">Peso real</TableHead>
                  <TableHead className="text-right" title="Teórico − real">
                    Rendimiento
                  </TableHead>
                  <TableHead className="text-right">Venta</TableHead>
                  <TableHead className="text-right">Costo prod.</TableHead>
                  <TableHead className="text-right">Utilidad</TableHead>
                  <TableHead className="text-right">Costo/kg compra</TableHead>
                  <TableHead className="text-right">Precio/kg venta</TableHead>
                  <TableHead className="text-right">Margen/kg</TableHead>
                  {/* C06: por metro lineal y por unidad de venta. */}
                  <TableHead className="text-right">Precio/ML venta</TableHead>
                  <TableHead className="text-right">Costo/ML</TableHead>
                  <TableHead className="text-right">Ganancia/ML</TableHead>
                  <TableHead className="text-right" title="Costo ÷ cantidad vendida">
                    Costo prom./unidad
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={17} className="text-muted-foreground">
                      No hay ventas trazables de {lineLabel} en ese rango.
                    </TableCell>
                  </TableRow>
                )}
                {data.subtotals.map((sub) => (
                  <KindGroup
                    key={sub.kind}
                    subtotal={sub}
                    kind={sub.kind}
                    rows={data.rows.filter((r) => r.kind === sub.kind)}
                    onOpen={setSelected}
                  />
                ))}
              </TableBody>
              {data.rows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3} className="font-semibold">
                      Total
                    </TableCell>
                    <FigureCells figures={data.total} />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>

          {data.untraceable.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">No trazable</h2>
              <p className="text-xs text-muted-foreground">
                Ventas del rango cuyo peso real y costo no salen del kardex de una bobina. No se
                estiman: quedan fuera de las filas de arriba (venta:{' '}
                {formatMoney(data.untraceableSalesPen)}).
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table data-testid="ventas-material-no-trazable">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Comprobante</TableHead>
                      <TableHead>Emisión</TableHead>
                      <TableHead>Pedido</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Motivo</TableHead>
                      <TableHead className="text-right">ML</TableHead>
                      <TableHead className="text-right">Venta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.untraceable.map((u, i) => (
                      <TableRow key={`${u.documentId}-${u.sku}-${u.reason}-${String(i)}`}>
                        <TableCell className="font-mono">{u.documentNumber ?? '—'}</TableCell>
                        <TableCell>{formatDate(u.issueDate)}</TableCell>
                        <TableCell className="font-mono">{u.orderCode ?? '—'}</TableCell>
                        <TableCell className="font-mono">{u.sku}</TableCell>
                        <TableCell>
                          {SALES_MATERIAL_KIND_LABELS[u.kind]} {u.thicknessMm} {u.colorLabel}
                        </TableCell>
                        <TableCell>{SALES_MATERIAL_UNTRACEABLE_LABELS[u.reason]}</TableCell>
                        <TableCell className="text-right">{formatQty(u.metersSold, 'm')}</TableCell>
                        <TableCell className="text-right">{formatMoney(u.salesPen)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}

      {data?.products && (
        <ProductTables products={data.products} untraceableSalesPen={data.untraceableSalesPen} />
      )}

      {data && <ReconciliationNotes data={data} line={line} from={dates.from} to={dates.to} />}

      <MaterialBreakdownDialog
        row={selected}
        onClose={() => {
          setSelected(null);
        }}
      />
    </RoleGate>
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
        Cuadre con Ventas y margen (sin filtros): venta de {lineLabel} facturada en el rango{' '}
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
          En el rango hay {formatMoney(data.noLineSalesPen)} de venta sin línea de negocio (líneas
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

/**
 * D-417 — Coberturas (UPVC) y Reventa: una fila por producto, con el costo de kardex de los
 * despachos que declaran el comprobante (el mismo dato que «Ventas y margen»). Lo que no se puede
 * atribuir así va aparte, con su motivo.
 */
function ProductTables({
  products,
  untraceableSalesPen,
}: {
  products: SalesByProductDto;
  untraceableSalesPen: string;
}) {
  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table data-testid="ventas-producto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Venta</TableHead>
              <TableHead className="text-right">Costo</TableHead>
              <TableHead className="text-right">Utilidad</TableHead>
              <TableHead className="text-right" title="Costo ÷ cantidad vendida">
                Costo prom./unidad
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No hay ventas con costo trazable en ese rango.
                </TableCell>
              </TableRow>
            )}
            {products.rows.map((r) => (
              <TableRow key={r.sku} data-testid="fila-producto">
                <TableCell className="font-mono">{r.sku}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right">{formatQty(r.qty, r.unit)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.salesPen)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.costPen)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.profitPen)}</TableCell>
                <TableCell className="text-right">{perUnit(r.costPerUnitPen, r.unit)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          {products.rows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-semibold">
                  Total
                </TableCell>
                <TableCell className="text-right">{formatMoney(products.total.salesPen)}</TableCell>
                <TableCell className="text-right">{formatMoney(products.total.costPen)}</TableCell>
                <TableCell className="text-right">
                  {formatMoney(products.total.profitPen)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      {products.untraceable.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">No trazable</h2>
          <p className="text-xs text-muted-foreground">
            Ventas del rango cuyo costo no sale de un despacho que declare el comprobante. No se
            estiman: quedan fuera de las filas de arriba (venta: {formatMoney(untraceableSalesPen)}
            ).
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table data-testid="ventas-producto-no-trazable">
              <TableHeader>
                <TableRow>
                  <TableHead>Comprobante</TableHead>
                  <TableHead>Emisión</TableHead>
                  <TableHead>Pedido</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead className="text-right">Cantidad</TableHead>
                  <TableHead className="text-right">Venta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.untraceable.map((u, i) => (
                  <TableRow key={`${u.documentId}-${u.sku}-${u.reason}-${String(i)}`}>
                    <TableCell className="font-mono">{u.documentNumber ?? '—'}</TableCell>
                    <TableCell>{formatDate(u.issueDate)}</TableCell>
                    <TableCell className="font-mono">{u.orderCode ?? '—'}</TableCell>
                    <TableCell className="font-mono">{u.sku}</TableCell>
                    <TableCell>{SALES_PRODUCT_UNTRACEABLE_LABELS[u.reason]}</TableCell>
                    <TableCell className="text-right">{formatQty(u.qty, u.unit)}</TableCell>
                    <TableCell className="text-right">{formatMoney(u.salesPen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
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
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
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

function FigureCells({ figures }: { figures: SalesMaterialFiguresDto }) {
  return (
    <>
      <TableCell className="text-right">{formatQty(figures.metersSold, 'm')}</TableCell>
      <TableCell className="text-right">{formatQty(figures.theoreticalKg, 'kg')}</TableCell>
      <TableCell className="text-right">{formatQty(figures.realKg, 'kg')}</TableCell>
      <TableCell className="text-right">
        {formatQty(figures.yieldKg, 'kg')}
        {figures.yieldPct !== null && (
          <span className="ml-1 text-muted-foreground">({figures.yieldPct} %)</span>
        )}
      </TableCell>
      <TableCell className="text-right">{formatMoney(figures.salesPen)}</TableCell>
      <TableCell className="text-right">{formatMoney(figures.costPen)}</TableCell>
      <TableCell className="text-right">{formatMoney(figures.profitPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.costPerKgPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.pricePerKgPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.marginPerKgPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.pricePerMeterPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.costPerMeterPen)}</TableCell>
      <TableCell className="text-right">{perKg(figures.marginPerMeterPen)}</TableCell>
      <TableCell className="text-right">{perUnit(figures.costPerUnitPen, figures.unit)}</TableCell>
    </>
  );
}

/** Un cociente: sin divisor (cantidad o metros en 0), «—», nunca 0 ni NaN. */
function perKg(value: string | null): string {
  return value === null ? '—' : formatMoney(value, 'PEN', 4);
}

/** C06: costo promedio por unidad de venta, con su unidad («S/ 10.0000 /m»). */
function perUnit(value: string | null, unit: string | null): string {
  if (value === null || unit === null) return '—';
  const symbol = unitSymbol(unit);
  return symbol === '' ? perKg(value) : `${perKg(value)} /${symbol}`;
}

function KindGroup({
  kind,
  rows,
  subtotal,
  onOpen,
}: {
  kind: SalesMaterialKind;
  rows: SalesMaterialRowDto[];
  subtotal: SalesMaterialFiguresDto;
  onOpen: (row: SalesMaterialRowDto) => void;
}) {
  return (
    <>
      {rows.map((row) => (
        <TableRow
          key={`${row.kind}-${row.thicknessMm}-${row.colorLabel}`}
          data-testid="fila-material"
          className="cursor-pointer hover:bg-muted/50"
          tabIndex={0}
          title="Ver el desglose por bobina y comprobante"
          onClick={() => {
            onOpen(row);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(row);
            }
          }}
        >
          <TableCell>{SALES_MATERIAL_KIND_LABELS[row.kind]}</TableCell>
          <TableCell className="text-right">{row.thicknessMm}</TableCell>
          <TableCell>{row.colorLabel}</TableCell>
          <FigureCells figures={row} />
        </TableRow>
      ))}
      <TableRow className="bg-muted/40 font-medium" data-testid="subtotal-material">
        <TableCell colSpan={3}>Subtotal {SALES_MATERIAL_KIND_LABELS[kind]}</TableCell>
        <FigureCells figures={subtotal} />
      </TableRow>
    </>
  );
}

/**
 * D-370 — desglose de una fila, en dos niveles.
 *
 * Nivel 1: las bobinas que alimentaron la venta de la fila (por tolerancia de espesor pudo ser
 * otra que la del producto, D-086), con el costo de kardex de lo consumido como dato principal y
 * el costo promedio por kg de la bobina debajo. Nivel 2: por bobina, los comprobantes que se
 * llevaron sus kilos y metros (una nota de crédito resta).
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
          Peso real y Costo prod. = suma de Kg consumidos y Costo prod.
        </p>
        <div className="max-h-[65vh] overflow-auto rounded-md border">
          <Table data-testid="bobinas-material">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Bobina</TableHead>
                <TableHead className="text-right">Espesor real</TableHead>
                <TableHead>Color</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Kg consumidos</TableHead>
                <TableHead className="text-right">Costo prod.</TableHead>
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
                        {formatQty(coil.kg, 'kg')}
                        {/* Lo que suma al peso teórico de la fila, para poder verificarlo. */}
                        <div className="text-xs text-muted-foreground">
                          teórico {formatQty(coil.theoreticalKg, 'kg')} ·{' '}
                          {formatQty(coil.meters, 'm')}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoney(coil.costPen)}
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
                                <TableHead>N°</TableHead>
                                <TableHead>Fecha</TableHead>
                                <TableHead>Cliente</TableHead>
                                <TableHead className="text-right">Kg atribuidos</TableHead>
                                <TableHead className="text-right">ML atribuidos</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {coil.documents.map((doc) => (
                                <TableRow key={doc.documentId}>
                                  <TableCell className="font-mono">
                                    <Link
                                      className={LINK_CLASSNAME}
                                      href={`/comprobantes/${doc.documentId}`}
                                    >
                                      {doc.documentNumber ?? 'Sin número'}
                                    </Link>
                                  </TableCell>
                                  <TableCell>{formatDate(doc.issueDate)}</TableCell>
                                  <TableCell>{doc.customerName}</TableCell>
                                  <TableCell className="text-right">
                                    {formatQty(doc.kg, 'kg')}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {formatQty(doc.meters, 'm')}
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
