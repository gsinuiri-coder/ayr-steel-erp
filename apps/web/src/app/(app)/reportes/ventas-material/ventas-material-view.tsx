'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Role,
  SALES_MATERIAL_KINDS,
  SALES_MATERIAL_KIND_LABELS,
  SALES_MATERIAL_UNTRACEABLE_LABELS,
  businessToday,
  type SalesByMaterialDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
  type SalesMaterialRowDto,
} from '@ayr/shared';
import { FilterChip } from '@/components/filter-chip';
import { HeaderActions } from '@/components/header-actions';
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
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import {
  KARDEX_RANGE_LABELS,
  kardexCustomPatch,
  parseKardexRange,
  resolveKardexDates,
} from '@/lib/kardex-range';
import { materialCoils, type CoilView } from '@/lib/material-coils';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';

/** Los presets de este reporte: sin «Todo», que no tiene sentido para un reporte de mes. */
const RANGES = ['month', 'prev'] as const;

/**
 * D-354 — Ventas por material de Coberturas Aluzinc. **Solo administrador**.
 *
 * Una fila por tipo × espesor × color del producto vendido, con las columnas de la planilla del
 * cliente. La venta es la de «Ventas y margen» (comprobantes del rango, sin IGV, netos de notas
 * de crédito); el peso real y el costo, los de las bobinas que consumió la producción de esas
 * líneas. Lo que no se puede trazar va aparte, con su motivo, y no se estima.
 */
export function VentasMaterialView() {
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
  const kind = (SALES_MATERIAL_KINDS as readonly string[]).includes(url.tipo)
    ? (url.tipo as SalesMaterialKind)
    : undefined;

  const base = `from=${dates.from}&to=${dates.to}`;
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

  const [modal, setModal] = useState<{ title: string; rows: SalesMaterialRowDto[] } | null>(null);
  const data = report.data;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Ventas por material</h1>
          <p className="text-xs text-muted-foreground">
            Coberturas Aluzinc. Comprobantes emitidos en el rango, sin IGV; peso real y costo de las
            bobinas que consumió la producción.
          </p>
        </div>
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
      </div>

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
        <FilterSelect
          label="Tipo"
          value={url.tipo}
          onChange={(v) => {
            setUrl({ tipo: v });
          }}
          options={SALES_MATERIAL_KINDS.map((k) => ({
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!data || data.rows.length === 0}
          onClick={() => {
            if (data) setModal({ title: 'Bobinas usadas — todas las filas', rows: data.rows });
          }}
        >
          Bobinas usadas
        </Button>
      </div>
      {!validRange && (
        <p className="text-xs text-destructive">La fecha «Desde» es posterior a «Hasta».</p>
      )}

      <p className="text-xs text-muted-foreground">
        La utilidad costea los kilos de bobina consumidos; no coincide con el margen de Ventas y
        margen, que costea al promedio del producto.
      </p>

      {report.isPending && validRange && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {data && (
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={13} className="text-muted-foreground">
                      No hay ventas trazables de Coberturas Aluzinc en ese rango.
                    </TableCell>
                  </TableRow>
                )}
                {data.subtotals.map((sub) => (
                  <KindGroup
                    key={sub.kind}
                    subtotal={sub}
                    kind={sub.kind}
                    rows={data.rows.filter((r) => r.kind === sub.kind)}
                    onOpen={(row) => {
                      setModal({
                        title: `Bobinas usadas — ${SALES_MATERIAL_KIND_LABELS[row.kind]} ${row.thicknessMm} mm ${row.colorLabel}`,
                        rows: [row],
                      });
                    }}
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

          <p className="text-xs text-muted-foreground" data-testid="cuadre-ventas-margen">
            Cuadre con Ventas y margen (sin filtros): Coberturas Aluzinc{' '}
            {formatMoney(data.reconciliation.roofingSalesPen)}; bobinas enteras de Coberturas
            Aluzinc (allá en Comercialización) {formatMoney(data.reconciliation.coilSalesPen)}.
            {data.reconciliation.unclassifiedSalesPen !== '0.0000' &&
              ` Productos de la línea sin subtipo, fuera de las filas: ${formatMoney(data.reconciliation.unclassifiedSalesPen)}.`}
          </p>
        </>
      )}

      <CoilsDialog
        open={modal !== null}
        title={modal?.title ?? ''}
        rows={modal?.rows ?? []}
        onClose={() => {
          setModal(null);
        }}
      />
    </RoleGate>
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
    </>
  );
}

function perKg(value: string | null): string {
  return value === null ? '—' : formatMoney(value, 'PEN', 4);
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
          title="Ver las bobinas usadas"
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

function CoilsDialog({
  open,
  title,
  rows,
  onClose,
}: {
  open: boolean;
  title: string;
  rows: SalesMaterialRowDto[];
  onClose: () => void;
}) {
  const [view, setView] = useState<CoilView>('sum');
  const lines = useMemo(() => materialCoils(rows, view), [rows, view]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {lines.length === 1 ? '1 bobina' : `${String(lines.length)} filas`}. Espesor y color de
            cada bobina: por tolerancia pudo usarse otra que la del producto.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2" role="group" aria-label="Vista de bobinas">
          <FilterChip
            active={view === 'sum'}
            onToggle={() => {
              setView('sum');
            }}
          >
            Sumado
          </FilterChip>
          <FilterChip
            active={view === 'split'}
            onToggle={() => {
              setView('split');
            }}
          >
            Desglosado
          </FilterChip>
        </div>
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table data-testid="bobinas-usadas">
            <TableHeader>
              <TableRow>
                <TableHead>Bobina</TableHead>
                <TableHead className="text-right">Espesor</TableHead>
                <TableHead>Color</TableHead>
                {view === 'split' && <TableHead>Tipo</TableHead>}
                <TableHead className="text-right">Kg consumidos</TableHead>
                <TableHead className="text-right">Costo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    Sin bobinas.
                  </TableCell>
                </TableRow>
              )}
              {lines.map((l) => (
                <TableRow key={l.key}>
                  <TableCell className="font-mono">{l.code}</TableCell>
                  <TableCell className="text-right">{l.thicknessMm}</TableCell>
                  <TableCell>{l.colorLabel}</TableCell>
                  {view === 'split' && (
                    <TableCell className={cn(l.kind === null && 'text-muted-foreground')}>
                      {l.kind === null ? '—' : SALES_MATERIAL_KIND_LABELS[l.kind]}
                    </TableCell>
                  )}
                  <TableCell className="text-right">{formatQty(l.kg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatMoney(l.costPen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
