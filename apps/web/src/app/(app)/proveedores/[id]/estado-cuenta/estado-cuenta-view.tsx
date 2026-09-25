'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  PURCHASE_TYPE_LABELS,
  Role,
  type SupplierStatementDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { RoleGate } from '@/components/role-gate';
import { formatDate, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

/** Estado de cuenta por proveedor (D-039): compras con saldo, antigüedad y total adeudado. */
export function EstadoCuentaView({ supplierId }: { supplierId: string }) {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<
    'document' | 'line' | 'type' | 'issue' | 'due' | 'total' | 'balance' | 'balancePen' | 'overdue'
  >();
  const statement = useQuery({
    queryKey: ['supplier-statement', supplierId],
    queryFn: () => api<SupplierStatementDto>(`/purchases/suppliers/${supplierId}/statement`),
  });

  if (statement.isPending) return <Skeleton className="h-64 w-full" />;
  if (statement.isError || !statement.data) {
    return <p className="text-destructive">No se pudo cargar el estado de cuenta.</p>;
  }

  const s = statement.data;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Estado de cuenta</h1>
          <p className="text-xs text-muted-foreground">
            {s.supplierCode} — {s.supplierName}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/proveedores">Volver a proveedores</Link>
        </Button>
      </div>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Total adeudado</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-semibold">{formatMoney(s.totalBalancePen)}</p>
          <p className="text-xs text-muted-foreground">
            Suma en soles del saldo de cada compra, convertido con el tipo de cambio que tenía esa
            compra.
          </p>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="document">
                Comprobante
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="line">
                Línea
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="type">
                Tipo
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="issue">
                Emisión
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="due">
                Vence
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="total"
                className="text-right"
                align="right"
              >
                Total
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="balance"
                className="text-right"
                align="right"
              >
                Saldo
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="balancePen"
                className="text-right"
                align="right"
              >
                Saldo en soles
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="overdue">
                Antigüedad
              </SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortRows(s.purchases, sort, {
              document: { text: (p) => p.documentLabel },
              line: { text: (p) => p.businessLine },
              type: { text: (p) => p.type },
              issue: { text: (p) => p.issueDate },
              due: { text: (p) => p.dueDate ?? '' },
              total: { decimal: (p) => String(p.total) },
              balance: { decimal: (p) => String(p.balance) },
              balancePen: { decimal: (p) => String(p.balancePen) },
              overdue: { decimal: (p) => String(p.overdueDays ?? '') },
            }).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  <Link href={`/compras/${p.id}`} className={LINK_CLASSNAME}>
                    {p.documentLabel}
                  </Link>
                </TableCell>
                <TableCell>{BUSINESS_LINE_LABELS[p.businessLine]}</TableCell>
                <TableCell>{PURCHASE_TYPE_LABELS[p.type]}</TableCell>
                <TableCell>{formatDate(p.issueDate)}</TableCell>
                <TableCell>{formatDate(p.dueDate)}</TableCell>
                <TableCell className="text-right">{formatMoney(p.total, p.currency)}</TableCell>
                <TableCell className="text-right">{formatMoney(p.balance, p.currency)}</TableCell>
                <TableCell className="text-right">{formatMoney(p.balancePen)}</TableCell>
                <TableCell>
                  {p.overdueDays === null ? (
                    <span className="text-muted-foreground">Contado</span>
                  ) : p.overdueDays > 0 ? (
                    <Badge variant="destructive">Vencida hace {p.overdueDays} d</Badge>
                  ) : p.overdueDays === 0 ? (
                    <Badge variant="secondary">Vence hoy</Badge>
                  ) : (
                    <span className="text-muted-foreground">
                      Vence en {Math.abs(p.overdueDays)} d
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {s.purchases.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  Este proveedor no tiene compras con saldo pendiente.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
