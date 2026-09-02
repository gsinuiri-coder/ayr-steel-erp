'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BUSINESS_LINE_LABELS, PURCHASE_TYPE_LABELS, type SupplierStatementDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Estado de cuenta por proveedor (D-039): compras con saldo, antigüedad y total adeudado. */
export function EstadoCuentaView({ supplierId }: { supplierId: string }) {
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
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Estado de cuenta</h1>
          <p className="text-sm text-muted-foreground">
            {s.supplierCode} — {s.supplierName}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/proveedores">Volver a proveedores</Link>
        </Button>
      </div>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">Total adeudado</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatMoney(s.totalBalancePen)}</p>
          <p className="text-xs text-muted-foreground">
            Suma en soles del saldo de cada compra, convertido con el tipo de cambio que tenía esa
            compra.
          </p>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Línea</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Vence</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <TableHead className="text-right">Saldo en soles</TableHead>
              <TableHead>Antigüedad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.purchases.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  <Link href={`/compras/${p.id}`} className="underline-offset-4 hover:underline">
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
    </>
  );
}
