'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUSES,
  type QuotationListItemDto,
  type QuotationStatus,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL = 'ALL';

/** Color del estado: solo la confirmada es un hecho; vencida y anulada son terminales. */
export function quotationStatusBadge(status: QuotationStatus, isExpired: boolean) {
  const label = QUOTATION_STATUS_LABELS[status];
  if (status === 'CONFIRMED') return <Badge>{label}</Badge>;
  if (status === 'CANCELLED' || status === 'EXPIRED')
    return <Badge variant="outline">{label}</Badge>;
  // Una emitida cuya fecha ya pasó pero que el job todavía no marcó: se avisa igual, o la
  // lista diría "Emitida" sobre algo que `confirmar` va a rechazar.
  if (status === 'EMITTED' && isExpired) return <Badge variant="outline">Vencida</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

/** RF-61/RF-69: listado de cotizaciones. */
export function CotizacionesView() {
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const params = new URLSearchParams();
  if (status !== ALL) params.set('status', status);
  const query = params.toString();

  const quotations = useQuery({
    queryKey: ['quotations', status],
    queryFn: () => api<QuotationListItemDto[]>(`/sales/quotations${query ? `?${query}` : ''}`),
  });

  const filtered = quotations.data?.filter((q) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return (
      q.code.toLowerCase().includes(needle) ||
      q.customerName.toLowerCase().includes(needle) ||
      q.customerDocNumber.includes(needle)
    );
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Cotizaciones</h1>
          <p className="text-sm text-muted-foreground">
            Cotizar no reserva stock; confirmar crea el pedido y la reserva (RF-61, RF-62).
          </p>
        </div>
        <Button asChild>
          <Link href="/cotizaciones/nueva">Nueva cotización</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por código, cliente o documento…"
          className="max-w-sm"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {QUOTATION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {QUOTATION_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Vigencia</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Pedido</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotations.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {quotations.isError && (
              <TableRow>
                <TableCell colSpan={7} className="text-destructive">
                  No se pudieron cargar las cotizaciones.
                </TableCell>
              </TableRow>
            )}
            {filtered?.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/cotizaciones/${q.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {q.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <div>{q.customerName}</div>
                  <div className="text-xs text-muted-foreground">{q.customerDocNumber}</div>
                </TableCell>
                <TableCell>{formatDate(q.issueDate)}</TableCell>
                <TableCell>{formatDate(q.validUntil)}</TableCell>
                <TableCell className="text-right">{formatMoney(q.totalPen)}</TableCell>
                <TableCell>{quotationStatusBadge(q.status, q.isExpired)}</TableCell>
                <TableCell>
                  {q.salesOrderId ? (
                    <Link
                      href={`/pedidos/${q.salesOrderId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {q.salesOrderCode}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filtered?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {search || status !== ALL
                    ? 'Ninguna cotización coincide con el filtro.'
                    : 'No hay cotizaciones todavía.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
