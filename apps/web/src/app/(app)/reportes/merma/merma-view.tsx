'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  BUSINESS_LINE_LABELS,
  COIL_REPORT_LINES,
  COIL_STATUS_LABELS,
  MISSING_THEORETICAL_LABELS,
  Role,
  businessToday,
  type CoilWasteDto,
  type CoilWasteLine,
  type CoilWasteRowDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { LineTabs } from '@/components/line-tabs';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { formatDate, formatQty } from '@/lib/format';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME } from '@/lib/utils';

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433). Merma por bobina en un rango. **Solo administrador**
 * (D-426), sin Excel.
 *
 * Entran las bobinas con producción en el rango, con las cifras del kardex del rango. La merma es
 * (consumido − teórico) + despunte + ajuste de cierre, sobre el teórico, contra el 1 % estándar.
 * Nada se estima: una bobina con una producción sin teórico atribuible lo declara y queda sin
 * porcentaje.
 */
export function MermaView() {
  const { tab, select } = useLineTab(LINE_TABS);
  // Sin «Todas», la pestaña siempre es una línea de este reporte.
  const line = tab as CoilWasteLine;
  const [url, setUrl] = useUrlState({ from: firstOfMonth(), to: businessToday() });
  const { from, to } = url;
  const validRange = DATE.test(from) && DATE.test(to) && from <= to;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const report = useQuery({
    queryKey: ['report', 'coil-waste', from, to, line],
    queryFn: () =>
      api<CoilWasteDto>(`/reports/coil-waste?from=${from}&to=${to}&businessLine=${line}`),
    enabled: validRange,
  });
  const data = report.data;
  const missingCount = data ? data.totals.coilCount - data.totals.comparableCoilCount : 0;

  const toggle = (coilId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(coilId)) next.delete(coilId);
      else next.add(coilId);
      return next;
    });
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Merma por bobina</h1>
          <p className="text-xs text-muted-foreground">
            {BUSINESS_LINE_LABELS[line]}. Bobinas con producción en el rango, con los movimientos de
            kardex del rango. Merma = (consumido − teórico) + despunte + ajuste de cierre; el
            porcentaje es sobre el teórico, contra el {data?.standardPct ?? '1.00'} % estándar.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="merma-desde">Desde</Label>
            <Input
              id="merma-desde"
              type="date"
              max={to}
              value={from}
              onChange={(e) => {
                if (e.target.value) setUrl({ from: e.target.value });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="merma-hasta">Hasta</Label>
            <Input
              id="merma-hasta"
              type="date"
              min={from}
              value={to}
              onChange={(e) => {
                if (e.target.value) setUrl({ to: e.target.value });
              }}
            />
          </div>
        </div>
      </div>

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {!validRange && (
        <p role="alert" className="text-sm text-destructive">
          El rango de fechas no es válido.
        </p>
      )}

      {data && (
        <StatStrip className="sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Bobinas">{data.totals.coilCount}</Stat>
          <Stat label="Consumido en producción">{formatQty(data.totals.consumedKg, 'kg')}</Stat>
          <Stat label="Teórico">{formatQty(data.totals.theoreticalKg, 'kg')}</Stat>
          <Stat label="Despunte">{formatQty(data.totals.trimKg, 'kg')}</Stat>
          <Stat label="Merma">{formatQty(data.totals.wasteKg, 'kg')}</Stat>
          <Stat label="Merma %">
            {data.totals.wastePct === null ? (
              '—'
            ) : (
              <PctBadge pct={data.totals.wastePct} std={data.standardPct} />
            )}
          </Stat>
        </StatStrip>
      )}

      {data && missingCount > 0 && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="aviso-sin-teorico">
          {missingCount === 1
            ? '1 bobina tiene una producción sin teórico atribuible: no tiene merma calculada y queda fuera del teórico, la merma y el porcentaje de arriba.'
            : `${missingCount} bobinas tienen producciones sin teórico atribuible: no tienen merma calculada y quedan fuera del teórico, la merma y el porcentaje de arriba.`}{' '}
          Ábrelas para ver el motivo.
        </p>
      )}
      {data && data.soldWhole.count > 0 && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="aviso-vendidas">
          {data.soldWhole.count === 1 ? 'Una bobina' : `${data.soldWhole.count} bobinas`} con
          producción en el rango se{' '}
          {data.soldWhole.count === 1 ? 'vendió entera' : 'vendieron enteras'} y no entra
          {data.soldWhole.count === 1 ? '' : 'n'} al reporte ({data.soldWhole.codes.join(', ')};
          consumo de producción {formatQty(data.soldWhole.consumedKg, 'kg')}).
        </p>
      )}

      {report.isPending && validRange && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {data && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Bobina</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Consumido</TableHead>
                <TableHead className="text-right">Teórico</TableHead>
                <TableHead className="text-right">Diferencia</TableHead>
                <TableHead className="text-right">Despunte</TableHead>
                <TableHead className="text-right">Ajuste de cierre</TableHead>
                <TableHead className="text-right">Merma</TableHead>
                <TableHead className="text-right">%</TableHead>
                <TableHead
                  className="text-right"
                  title="Merma manual (RF-17): informativa, fuera de la merma"
                >
                  Otra merma (manual)
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                    No hay bobinas de esta línea con producción en ese rango.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((row) => (
                <CoilRows
                  key={row.coilId}
                  row={row}
                  std={data.standardPct}
                  open={open.has(row.coilId)}
                  onToggle={() => {
                    toggle(row.coilId);
                  }}
                />
              ))}
            </TableBody>
            {data.rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>
                    Total de {BUSINESS_LINE_LABELS[line]}
                    {missingCount > 0 && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        Teórico, diferencia y merma: {data.totals.comparableCoilCount} de{' '}
                        {data.totals.coilCount} bobinas
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right" data-testid="merma-total-consumido">
                    {formatQty(data.totals.consumedKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.theoreticalKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.differenceKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.trimKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.closeAdjustmentKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.wasteKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    {data.totals.wastePct === null ? (
                      '—'
                    ) : (
                      <PctBadge pct={data.totals.wastePct} std={data.standardPct} />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(data.totals.manualScrapKg, 'kg')}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
    </RoleGate>
  );
}

/** La fila de la bobina y, abierta, sus producciones del rango. */
function CoilRows({
  row,
  std,
  open,
  onToggle,
}: {
  row: CoilWasteRowDto;
  std: string;
  open: boolean;
  onToggle: () => void;
}) {
  const flagged = row.productions.filter((p) => p.outOfTolerance !== null).length;
  const missing = row.productions.some((p) => p.missingTheoretical !== null);
  return (
    <>
      <TableRow data-testid="merma-bobina">
        <TableCell>
          <div className="flex items-start gap-1">
            <button
              type="button"
              className="mt-0.5"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={`Producciones de ${row.code}`}
            >
              {open ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
            </button>
            <div>
              <Link className={`${LINK_CLASSNAME} font-mono`} href={`/bobinas/${row.coilId}`}>
                {row.code}
              </Link>
              <div className="text-xs text-muted-foreground">
                {row.typeKey}
                {row.colorName ? ` · ${row.colorName}` : ''} · {formatQty(row.widthMm, 'mm')}
              </div>
              {flagged > 0 && (
                <Badge variant="warning" className="mt-1">
                  Fuera de tolerancia{flagged > 1 ? ` (${flagged})` : ''}
                </Badge>
              )}
              {missing && (
                <Badge variant="secondary" className="mt-1">
                  Sin teórico atribuible
                </Badge>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell>{COIL_STATUS_LABELS[row.status]}</TableCell>
        <TableCell className="text-right">{formatQty(row.consumedKg, 'kg')}</TableCell>
        <TableCell className="text-right">{kgOrDash(row.theoreticalKg)}</TableCell>
        <TableCell className="text-right">{kgOrDash(row.differenceKg)}</TableCell>
        <TableCell className="text-right">{formatQty(row.trimKg, 'kg')}</TableCell>
        <TableCell className="text-right">{formatQty(row.closeAdjustmentKg, 'kg')}</TableCell>
        <TableCell className="text-right font-medium">{kgOrDash(row.wasteKg)}</TableCell>
        <TableCell className="text-right">
          {row.wastePct === null ? '—' : <PctBadge pct={row.wastePct} std={std} />}
        </TableCell>
        <TableCell className="text-right text-muted-foreground">
          {formatQty(row.manualScrapKg, 'kg')}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="p-0">
            <Table aria-label={`Producciones de ${row.code}`}>
              <TableHeader>
                <TableRow className="text-xs">
                  <TableHead className="pl-8">Orden</TableHead>
                  <TableHead>Fecha</TableHead>
                  <TableHead className="text-right">Consumido</TableHead>
                  <TableHead className="text-right">Teórico</TableHead>
                  <TableHead>Observación</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {row.productions.map((p, i) => (
                  <Fragment key={p.reportId ?? `sin-reporte-${i}`}>
                    <TableRow className="text-xs" data-testid="merma-produccion">
                      <TableCell className="pl-8">
                        {p.productionOrderId && p.productionOrderCode ? (
                          <Link
                            className={`${LINK_CLASSNAME} font-mono`}
                            href={`/produccion/${p.productionOrderId}`}
                          >
                            {p.productionOrderCode}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{formatDate(p.operationDate)}</TableCell>
                      <TableCell className="text-right">{formatQty(p.consumedKg, 'kg')}</TableCell>
                      <TableCell className="text-right">{kgOrDash(p.theoreticalKg)}</TableCell>
                      <TableCell>
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
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** El porcentaje, en rojo si pasa el estándar. */
function PctBadge({ pct, std }: { pct: string; std: string }) {
  const over = Number(pct) > Number(std);
  return over ? <Badge variant="destructive">{pct} %</Badge> : <span>{pct} %</span>;
}

function kgOrDash(value: string | null): string {
  return value === null ? '—' : formatQty(value, 'kg');
}

/** cc25 (D-424): Coberturas Aluzinc y Drywall, sin «Todas»; el rango sobrevive. */
const LINE_TABS: LineTabsConfig = {
  lines: COIL_REPORT_LINES,
  includeAll: false,
  keep: ['from', 'to'],
};

/** Bobina, estado, las siete cifras y el porcentaje. */
const COLUMNS = 10;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Primer día del mes de negocio en curso, el rango por defecto. */
function firstOfMonth(): string {
  return `${businessToday().slice(0, 7)}-01`;
}
