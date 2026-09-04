'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  FISCAL_DOC_TYPE_LABELS,
  Role,
  toDecimal,
  type FiscalDocumentListItemDto,
  type ReceivableSummaryDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
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

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/**
 * RF-88: cuentas por cobrar.
 *
 * Dos vistas del mismo hecho: el resumen por cliente —para saber a quién llamar— y el
 * detalle por comprobante, que es donde se cobra (D-075: el cobro va contra el
 * comprobante, no contra el pedido).
 */
export function CobranzasView() {
  const receivables = useQuery({
    queryKey: ['receivables'],
    queryFn: () => api<ReceivableSummaryDto[]>('/invoicing/receivables'),
  });

  const pending = useQuery({
    queryKey: ['fiscal-documents', 'pending'],
    queryFn: () => api<FiscalDocumentListItemDto[]>('/invoicing/documents?pendingOnly=true'),
  });

  const totalBalance = (receivables.data ?? []).reduce(
    (acc, r) => acc.plus(toDecimal(r.balancePen)),
    toDecimal('0'),
  );
  const totalOverdue = (receivables.data ?? []).reduce(
    (acc, r) => acc.plus(toDecimal(r.overduePen)),
    toDecimal('0'),
  );

  return (
    <RoleGate allow={SALES_ROLES}>
      <div>
        <h1 className="text-2xl font-semibold">Cobranzas</h1>
        <p className="text-sm text-muted-foreground">
          Saldo por comprobante. El cobro se registra desde el comprobante, y revertirlo devuelve el
          monto al saldo.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Por cobrar</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {formatMoney(totalBalance.toFixed(4))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Vencido</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-destructive">
            {formatMoney(totalOverdue.toFixed(4))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Clientes</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {receivables.data?.length ?? 0}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Por cliente</h2>
        {receivables.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="text-right">Comprobantes</TableHead>
                  <TableHead>Vencimiento más próximo</TableHead>
                  <TableHead className="text-right">Vencido</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(receivables.data ?? []).map((r) => (
                  <TableRow key={r.customerId}>
                    <TableCell>
                      <div className="font-medium">{r.customerName}</div>
                      <div className="text-xs text-muted-foreground">{r.customerDocNumber}</div>
                    </TableCell>
                    <TableCell className="text-right">{r.documentCount}</TableCell>
                    <TableCell>
                      {r.nextDueDate ? (
                        formatDate(r.nextDueDate)
                      ) : (
                        <span className="text-muted-foreground">Contado</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {toDecimal(r.overduePen).gt(0) ? (
                        <span className="font-medium text-destructive">
                          {formatMoney(r.overduePen)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(r.balancePen)}
                    </TableCell>
                  </TableRow>
                ))}
                {(receivables.data?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No hay nada por cobrar.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Comprobantes con saldo</h2>
        {pending.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Emisión</TableHead>
                  <TableHead>Vencimiento</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Cobrado</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pending.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link
                        href={`/comprobantes/${d.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {d.number ?? 'Borrador'}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {FISCAL_DOC_TYPE_LABELS[d.docType]}
                      </div>
                    </TableCell>
                    <TableCell>{d.customerName}</TableCell>
                    <TableCell>{formatDate(d.issueDate)}</TableCell>
                    <TableCell>
                      {d.dueDate ? (
                        <span className={d.isOverdue ? 'font-medium text-destructive' : undefined}>
                          {formatDate(d.dueDate)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Contado</span>
                      )}
                      {d.isOverdue && (
                        <Badge variant="outline" className="ml-2">
                          Vencido
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(d.totalPen)}</TableCell>
                    <TableCell className="text-right">{formatMoney(d.paidPen)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(d.balancePen)}
                    </TableCell>
                  </TableRow>
                ))}
                {(pending.data?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      Ningún comprobante tiene saldo pendiente.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </RoleGate>
  );
}
