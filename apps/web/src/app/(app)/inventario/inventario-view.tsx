'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  NOOP_INVENTORY_LINES,
  BUSINESS_LINES,
  Role,
  type BusinessLine,
  type InventorySummaryDto,
  type InventorySummaryRowDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatMoneyOrDash, formatQty, unitSymbol } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** `services` no lleva stock (§2.2), así que no tiene pestaña de inventario. */
const STOCK_LINES = BUSINESS_LINES.filter((line) => !NOOP_INVENTORY_LINES.includes(line));

/**
 * Inventario valorizado por línea de negocio (RF-23, RF-51). Las bobinas se agrupan por
 * `typeKey` (acabado + espesor, RF-14) y los productos por SKU; el valorizado va en
 * soles (D-042) porque el kardex se lleva en soles.
 */
export function InventarioView() {
  const [line, setLine] = useState<BusinessLine>(STOCK_LINES[0] ?? 'drywall');

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR]}>
      <div>
        <h1 className="text-2xl font-semibold">Inventario</h1>
        <p className="text-sm text-muted-foreground">
          Stock valorizado en soles por línea de negocio (RF-51). Las bobinas se agrupan por tipo:
          mismo acabado y espesor, sin importar el ancho (RF-14).
        </p>
      </div>

      <Tabs
        value={line}
        onValueChange={(v) => {
          setLine(v as BusinessLine);
        }}
      >
        <TabsList>
          {STOCK_LINES.map((l) => (
            <TabsTrigger key={l} value={l}>
              {BUSINESS_LINE_LABELS[l]}
            </TabsTrigger>
          ))}
        </TabsList>
        {STOCK_LINES.map((l) => (
          <TabsContent key={l} value={l} className="mt-4 grid gap-4">
            <LinePanel line={l} />
          </TabsContent>
        ))}
      </Tabs>
    </RoleGate>
  );
}

function LinePanel({ line }: { line: BusinessLine }) {
  const summary = useQuery({
    queryKey: ['inventory', 'summary', line],
    queryFn: () => api<InventorySummaryDto>(`/inventory/summary?businessLine=${line}`),
  });

  if (summary.isPending) return <Skeleton className="h-48 w-full" />;
  if (summary.isError || !summary.data) {
    return <p className="text-destructive">No se pudo cargar el inventario de esta línea.</p>;
  }

  const { coils, products, totalValuePen } = summary.data;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Valorizado de la línea</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold" data-testid="inventario-total">
            {formatMoneyOrDash(totalValuePen)}
          </p>
          <p className="text-sm text-muted-foreground">
            {coils.length} tipo(s) de bobina y {products.length} producto(s) con saldo.
          </p>
        </CardContent>
      </Card>

      <SummaryTable
        title="Bobinas por tipo"
        emptyLabel="No hay bobinas con saldo en esta línea."
        rows={coils}
        keyHeader="Tipo (acabado-espesor)"
      />
      <SummaryTable
        title="Productos de catálogo"
        emptyLabel="No hay productos con saldo en esta línea."
        rows={products}
        keyHeader="SKU"
      />
    </>
  );
}

function SummaryTable({
  title,
  keyHeader,
  emptyLabel,
  rows,
}: {
  title: string;
  keyHeader: string;
  emptyLabel: string;
  rows: InventorySummaryRowDto[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{keyHeader}</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead className="text-right">Ítems</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Costo prom.</TableHead>
              <TableHead className="text-right">Valorizado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.itemType}:${row.key}`}>
                <TableCell className="font-mono font-medium">
                  {/* Solo se enlaza al kardex cuando la fila es un ítem único: el kardex
                      de un grupo de bobinas distintas no existe como tal (RF-53). */}
                  {row.itemId ? (
                    <Link
                      className="underline underline-offset-4"
                      href={`/kardex?itemType=${row.itemType}&item=${row.itemId}`}
                    >
                      {row.key}
                    </Link>
                  ) : (
                    row.key
                  )}
                </TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-right">{row.itemCount}</TableCell>
                <TableCell className="text-right">
                  {formatQty(row.qty, unitSymbol(row.unit))}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoneyOrDash(row.avgCostPen, 'PEN', 4)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatMoneyOrDash(row.totalValuePen)}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {emptyLabel}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
