'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_STATUS_LABELS,
  Role,
  type InventoryValuationCoilGroupDto,
  type InventoryValuationDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
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
 * Las bobinas se agrupan por línea / espesor / color, que es como se mira el inventario
 * cuando la pregunta es cuánto vale, y cada grupo se abre a sus bobinas. No es el mismo
 * corte que `/inventario`, que agrupa por `typeKey` (acabado + espesor, sin color) para
 * responder qué hay disponible para vender.
 */
export function InventarioValorizadoView() {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const report = useQuery({
    queryKey: ['report', 'inventory-valuation'],
    queryFn: () => api<InventoryValuationDto>('/reports/inventory-valuation'),
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
      </div>

      {report.data && (
        <StatStrip className="sm:grid-cols-3 lg:grid-cols-3">
          <Stat label="Bobinas">{formatMoney(report.data.totals.coilValuePen)}</Stat>
          <Stat label="Productos">{formatMoney(report.data.totals.productValuePen)}</Stat>
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
                      <TableCell className="text-right">{formatMoney(p.avgCostPen)}</TableCell>
                      <TableCell className="text-right">{formatMoney(p.totalValuePen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

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
                      <TableCell className="text-right">{formatMoney(t.productValuePen)}</TableCell>
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
        <TableCell>{group.colorName ?? 'Sin color'}</TableCell>
        <TableCell className="text-right">{group.coilCount}</TableCell>
        <TableCell className="text-right">{formatQty(group.qtyKg, 'kg')}</TableCell>
        <TableCell className="text-right">{formatMoney(group.avgCostPen)}</TableCell>
        <TableCell className="text-right font-medium">{formatMoney(group.totalValuePen)}</TableCell>
      </TableRow>
      {open &&
        group.coils.map((coil) => (
          <TableRow key={coil.id} className="bg-muted/40 text-xs">
            <TableCell className="pl-8 font-mono">
              <Link className={LINK_CLASSNAME} href={`/bobinas/${coil.id}`}>
                {coil.code}
              </Link>
            </TableCell>
            <TableCell className="text-right">{formatQty(coil.widthMm, 'mm')}</TableCell>
            <TableCell>
              {/*
                El estado se muestra en el detalle porque una bobina con saldo que no está
                abierta es una anomalía (D-164 liquida el remanente al cerrar): el reporte la
                deja ver en vez de filtrarla, que la escondería del total.
              */}
              <Badge variant={coil.status === 'OPEN' ? 'secondary' : 'destructive'}>
                {COIL_STATUS_LABELS[coil.status]}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{formatDate(coil.operationDate)}</TableCell>
            <TableCell className="text-right">{formatQty(coil.qtyKg, 'kg')}</TableCell>
            <TableCell className="text-right">{formatMoney(coil.avgCostPen)}</TableCell>
            <TableCell className="text-right">{formatMoney(coil.totalValuePen)}</TableCell>
          </TableRow>
        ))}
    </>
  );
}
