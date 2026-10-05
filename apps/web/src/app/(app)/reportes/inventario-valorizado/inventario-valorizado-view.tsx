'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_BUSINESS_LINES,
  COIL_STATUS_LABELS,
  INVENTORY_VALUATION_LINES,
  coilGroupLabel,
  Role,
  type InventoryValuationCoilGroupDto,
  type InventoryValuationDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LINK_CLASSNAME } from '@/lib/utils';

/**
 * Inventario valorizado a hoy (RF-S4a/M1). **Solo administrador**: cada fila lleva costo.
 *
 * Las bobinas se agrupan por línea / espesor / color comercial (D-272; sin color, por tipo de
 * acabado), que es como se mira el inventario cuando la pregunta es cuánto vale. Debajo del
 * color va el detalle por acabado —que es donde vive el RAL (D-270)— y cada grupo se abre a
 * sus bobinas. No es el mismo
 * corte que `/inventario`, que agrupa por `typeKey` (acabado + espesor, sin color) para
 * responder qué hay disponible para vender.
 */

/**
 * P-14: el costo promedio (por kilo o por unidad) se muestra a 4 decimales, la escala con la
 * que se guarda; a 2, el costo × la cantidad no reproducía el valor de la fila.
 */
const COST_DECIMALS = 4;

/** cc23 (D-391, D-393): las líneas con inventario, con «Todas» primera y por defecto. */
const LINE_TABS: LineTabsConfig = { lines: INVENTORY_VALUATION_LINES, includeAll: true };

export function InventarioValorizadoView() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { tab, line, select } = useLineTab(LINE_TABS);
  // D-391: kilos en las líneas con bobinas; unidades en Coberturas (UPVC) y Reventa, que no
  // tienen bobinas propias (la bobina de reventa vive en la línea que la compró, D-116).
  const hasCoils = line === undefined || COIL_BUSINESS_LINES.includes(line);

  const report = useQuery({
    queryKey: ['report', 'inventory-valuation', line ?? 'todas'],
    queryFn: () =>
      api<InventoryValuationDto>(
        line === undefined
          ? '/reports/inventory-valuation'
          : `/reports/inventory-valuation?businessLine=${line}`,
      ),
  });

  const toggle = (key: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Inventario valorizado</h1>
          <p className="text-xs text-muted-foreground">
            {report.data
              ? `Saldo y costo promedio al ${formatDate(report.data.asOf)}.`
              : 'Saldo de kardex por su costo promedio ponderado.'}
          </p>
        </div>
        {/* Descarga directa contra el API (patrón D-149): el archivo sale del mismo DTO que
            esta pantalla, así que no hay dos caminos que puedan divergir. D-396: sin
            exportación por línea; el Excel es el de «Todas» y solo se ofrece ahí. */}
        {line === undefined && (
          <HeaderActions
            primary={['xlsx']}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: '/api/reports/inventory-valuation/xlsx',
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

      {report.data && hasCoils && (
        <StatStrip className="sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Bobinas">{formatMoney(report.data.totals.coilValuePen)}</Stat>
          <Stat label="Bobinas (kg)">{formatQty(report.data.totals.coilQtyKg, 'kg')}</Stat>
          <Stat label="Productos">{formatMoney(report.data.totals.productValuePen)}</Stat>
          <Stat label="Total">{formatMoney(report.data.totals.totalValuePen)}</Stat>
        </StatStrip>
      )}
      {report.data && !hasCoils && (
        <StatStrip className="sm:grid-cols-2 lg:grid-cols-2">
          <Stat label="Productos con stock">{report.data.products.length}</Stat>
          <Stat label="Total">{formatMoney(report.data.totals.totalValuePen)}</Stat>
        </StatStrip>
      )}

      {report.isPending && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {report.data && (
        <>
          {hasCoils && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Bobinas con saldo</h2>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <TableHead>Línea</TableHead>
                      <TableHead className="text-right">Espesor</TableHead>
                      <TableHead>Color</TableHead>
                      <TableHead className="text-right">Bobinas</TableHead>
                      <TableHead className="text-right">Saldo (kg)</TableHead>
                      <TableHead className="text-right">Costo/kg</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.coilGroups.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-muted-foreground">
                          No hay bobinas con saldo.
                        </TableCell>
                      </TableRow>
                    )}
                    {report.data.coilGroups.map((group) => (
                      <CoilGroupRows
                        key={group.key}
                        group={group}
                        open={open.has(group.key)}
                        onToggle={() => {
                          toggle(group.key);
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Productos con stock</h2>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Descripción</TableHead>
                    <TableHead className="hidden md:table-cell">Línea</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Costo unitario</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.products.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        No hay productos con stock.
                      </TableCell>
                    </TableRow>
                  )}
                  {report.data.products.map((p) => (
                    <TableRow key={p.itemId}>
                      <TableCell className="font-mono">{p.sku}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {BUSINESS_LINE_LABELS[p.businessLine]}
                      </TableCell>
                      <TableCell className="text-right">{formatQty(p.qty, p.unit)}</TableCell>
                      <TableCell className="text-right">
                        {formatMoney(p.avgCostPen, 'PEN', COST_DECIMALS)}
                      </TableCell>
                      <TableCell className="text-right">{formatMoney(p.totalValuePen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* En la pestaña de una línea, la tabla repetiría la franja de arriba: solo en «Todas». */}
          {line === undefined && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Totales por línea de negocio</h2>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Línea</TableHead>
                      <TableHead className="text-right">Bobinas</TableHead>
                      <TableHead className="text-right">Productos</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.totalsByLine.map((t) => (
                      <TableRow key={t.businessLine}>
                        <TableCell>{BUSINESS_LINE_LABELS[t.businessLine]}</TableCell>
                        <TableCell className="text-right">{formatMoney(t.coilValuePen)}</TableCell>
                        <TableCell className="text-right">
                          {formatMoney(t.productValuePen)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatMoney(t.totalValuePen)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2">
                      <TableCell className="font-semibold">Total general</TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatMoney(report.data.totals.coilValuePen)}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatMoney(report.data.totals.productValuePen)}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatMoney(report.data.totals.totalValuePen)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </RoleGate>
  );
}

/** La fila del grupo y, si está abierto, el detalle de sus bobinas debajo. */
function CoilGroupRows({
  group,
  open,
  onToggle,
}: {
  group: InventoryValuationCoilGroupDto;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="grupo-bobinas"
      >
        <TableCell>{BUSINESS_LINE_LABELS[group.businessLine]}</TableCell>
        <TableCell className="text-right">{formatQty(group.thicknessMm, 'mm')}</TableCell>
        <TableCell>
          <div>{coilGroupLabel(group)}</div>
          {/* D-272: el RAL como detalle del color, sin abrir el grupo. */}
          {group.finishes.length > 0 && (
            <ul className="text-xs text-muted-foreground" aria-label="Detalle por acabado">
              {group.finishes.map((f) => (
                <li key={f.finishCode}>
                  {f.ral === null ? f.finishCode : `RAL ${f.ral} (${f.finishCode})`}:{' '}
                  {formatQty(f.qtyKg, 'kg')} · {formatMoney(f.totalValuePen)}
                </li>
              ))}
            </ul>
          )}
        </TableCell>
        <TableCell className="text-right">{group.coilCount}</TableCell>
        <TableCell className="text-right">{formatQty(group.qtyKg, 'kg')}</TableCell>
        <TableCell className="text-right">
          {formatMoney(group.avgCostPen, 'PEN', COST_DECIMALS)}
        </TableCell>
        <TableCell className="text-right font-medium">{formatMoney(group.totalValuePen)}</TableCell>
      </TableRow>
      {/*
        El detalle comparte la tabla del grupo, así que solo puede usar las columnas cuyo
        encabezado signifique lo mismo para una bobina que para su grupo: saldo, costo/kg y
        valor. Lo que es propio de la bobina —ancho, estado, fecha de alta— va **dentro de la
        primera celda** y rotulado, no repartido por las columnas de la izquierda: ahí el
        ancho caía bajo «Espesor» y la fecha bajo «Bobinas», o sea un dato correcto debajo de
        un rótulo que decía otra cosa.
      */}
      {open &&
        group.coils.map((coil) => (
          <TableRow key={coil.id} className="bg-muted/40 text-xs">
            <TableCell className="pl-8" colSpan={4}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link className={`${LINK_CLASSNAME} font-mono`} href={`/bobinas/${coil.id}`}>
                  {coil.code}
                </Link>
                <span className="text-muted-foreground">Ancho {formatQty(coil.widthMm, 'mm')}</span>
                <span className="text-muted-foreground">
                  {coil.finishCode}
                  {coil.ral !== null && ` · RAL ${coil.ral}`}
                </span>
                <span className="text-muted-foreground">Alta {formatDate(coil.operationDate)}</span>
                {/*
                  El estado solo se muestra cuando **no** es «Abierta»: una bobina con saldo
                  que no está abierta es una anomalía (D-164 liquida el remanente al cerrar) y
                  el reporte la delata en vez de filtrarla. Rotular las normales no aporta y
                  deja la columna llena de insignias que nadie lee.
                */}
                {coil.status !== 'OPEN' && (
                  <Badge variant="destructive">{COIL_STATUS_LABELS[coil.status]}</Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right">{formatQty(coil.qtyKg, 'kg')}</TableCell>
            <TableCell className="text-right">
              {formatMoney(coil.avgCostPen, 'PEN', COST_DECIMALS)}
            </TableCell>
            <TableCell className="text-right">{formatMoney(coil.totalValuePen)}</TableCell>
          </TableRow>
        ))}
    </>
  );
}
