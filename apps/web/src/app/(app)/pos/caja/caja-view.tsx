'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CASH_SESSION_STATUS_LABELS,
  Decimal,
  PAYMENT_METHOD_LABELS,
  POS_SALE_STATUS_LABELS,
  PosSaleStatus,
  Role,
  toDecimal,
  type CashSessionDto,
  type PosSaleListItemDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { invalidatePos } from '@/lib/pos-queries';
import { useSession } from '@/lib/session';
import { RoleGate } from '@/components/role-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const POS_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/**
 * Caja del mostrador (RF-60; D-100, D-101).
 *
 * Dos cosas y nada más: el turno abierto con su arqueo, y las ventas que entraron en él.
 * El esperado que muestra la tarjeta es el mismo que el API va a usar al cerrar —sale de
 * `expectedCash` en `@ayr/shared`—, así que el cajero cuenta contra la cifra correcta y no
 * contra una aproximación de pantalla.
 */
export function CajaView() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<PosSaleListItemDto | null>(null);

  const sessions = useQuery({
    queryKey: ['cash-sessions'],
    queryFn: () => api<CashSessionDto[]>('/pos/cash-sessions'),
  });

  const open = sessions.data?.find((s) => s.status === 'OPEN') ?? null;

  const sales = useQuery({
    queryKey: ['cash-session-sales', open?.id],
    queryFn: () => api<PosSaleListItemDto[]>(`/pos/cash-sessions/${open?.id ?? ''}/sales`),
    enabled: open !== null,
  });

  const difference = useMemo(() => {
    if (open === null || counted.trim() === '') return null;
    try {
      return toDecimal(counted.trim()).minus(toDecimal(open.expectedCashPen));
    } catch {
      return null;
    }
  }, [counted, open]);

  const close = useMutation({
    mutationFn: () =>
      api<CashSessionDto>(`/pos/cash-sessions/${open?.id ?? ''}/close`, {
        method: 'POST',
        body: { countedCashPen: counted.trim(), notes: notes.trim() || undefined },
      }),
    onMutate: () => {
      setError(null);
    },
    onSuccess: () => {
      setCounted('');
      setNotes('');
      invalidatePos(queryClient);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'No se pudo cerrar la caja');
    },
  });

  const voidSale = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api<PosSaleListItemDto>(`/pos/sales/${input.id}/void`, {
        method: 'POST',
        body: { reason: input.reason },
      }),
    onSuccess: (sale) => {
      setVoiding(null);
      invalidatePos(queryClient, {
        cashSessionId: sale.cashSessionId,
        orderId: sale.salesOrderId,
        documentId: sale.fiscalDocumentId,
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'No se pudo anular la venta');
    },
  });

  const closed = (sessions.data ?? []).filter((s) => s.status === 'CLOSED');

  return (
    <RoleGate allow={POS_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Caja</h1>
          <p className="text-sm text-muted-foreground">
            El arqueo compara el efectivo esperado del turno contra el que cuentas. Tarjeta, Yape y
            transferencia se listan aparte: no ponen billetes en el cajón.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/pos">Volver al mostrador</Link>
        </Button>
      </div>

      {sessions.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : open === null ? (
        <Card>
          <CardHeader>
            <CardTitle>No tienes una caja abierta</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Abre tu turno desde el mostrador para empezar a vender.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Card>
            <CardHeader>
              <CardTitle>
                {open.code} · {CASH_SESSION_STATUS_LABELS[open.status]}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Apertura</dt>
                  <dd className="font-medium">{formatMoney(open.openingAmountPen)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Efectivo esperado</dt>
                  <dd className="font-medium">{formatMoney(open.expectedCashPen)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Ventas del turno</dt>
                  <dd className="font-medium">{open.saleCount}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Total cobrado</dt>
                  <dd className="font-medium">{formatMoney(open.totalPen)}</dd>
                </div>
              </dl>

              <div className="grid gap-2 border-t pt-3">
                {open.totals
                  .filter((t) => t.saleCount > 0)
                  .map((t) => (
                    <div key={t.method} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {PAYMENT_METHOD_LABELS[t.method]} · {t.saleCount}
                      </span>
                      <span>{formatMoney(t.totalPen)}</span>
                    </div>
                  ))}
                {open.saleCount === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Todavía no hay ventas en el turno.
                  </p>
                )}
              </div>

              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Venta</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Comprobante</TableHead>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(sales.data ?? []).map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">
                          {s.code}
                          {s.status === PosSaleStatus.VOIDED && (
                            <Badge variant="secondary" className="ml-2">
                              {POS_SALE_STATUS_LABELS[s.status]}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{s.customerName}</TableCell>
                        <TableCell>
                          <Link
                            className="underline underline-offset-4"
                            href={`/comprobantes/${s.fiscalDocumentId}`}
                          >
                            {s.fiscalDocumentNumber ?? 'borrador'}
                          </Link>
                          {s.fiscalPending && (
                            <span className="ml-2 text-xs text-muted-foreground">pendiente</span>
                          )}
                        </TableCell>
                        <TableCell>{PAYMENT_METHOD_LABELS[s.method]}</TableCell>
                        <TableCell className="text-right">{formatMoney(s.totalPen)}</TableCell>
                        <TableCell className="text-right">
                          {s.status === PosSaleStatus.ACTIVE &&
                            user.role === Role.ADMINISTRADOR && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setVoiding(s);
                                }}
                              >
                                Anular
                              </Button>
                            )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(sales.data ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-muted-foreground">
                          Sin ventas todavía.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:sticky lg:top-4 lg:self-start">
            <CardHeader>
              <CardTitle>Cerrar el turno</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="caja-contado">Efectivo contado (S/)</Label>
                <Input
                  id="caja-contado"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => {
                    setCounted(e.target.value);
                  }}
                />
              </div>

              {difference !== null && (
                <p
                  className={
                    difference.isZero()
                      ? 'text-sm text-muted-foreground'
                      : 'text-sm text-destructive'
                  }
                >
                  {difference.isZero()
                    ? 'La caja cuadra.'
                    : `Diferencia de ${formatMoney(difference.toFixed(4))} (${difference.gt(0) ? 'sobrante' : 'faltante'}). Hace falta el motivo${user.role === Role.ADMINISTRADOR ? '' : ' y que la cierre un administrador'}.`}
                </p>
              )}

              {difference !== null && !difference.isZero() && (
                <div className="grid gap-1.5">
                  <Label htmlFor="caja-motivo">Motivo de la diferencia</Label>
                  <Input
                    id="caja-motivo"
                    value={notes}
                    onChange={(e) => {
                      setNotes(e.target.value);
                    }}
                  />
                </div>
              )}

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button
                disabled={counted.trim() === '' || close.isPending}
                onClick={() => {
                  close.mutate();
                }}
              >
                {close.isPending ? 'Cerrando…' : 'Cerrar caja'}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {closed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Turnos cerrados</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Turno</TableHead>
                  <TableHead>Cajero</TableHead>
                  <TableHead className="text-right">Esperado</TableHead>
                  <TableHead className="text-right">Contado</TableHead>
                  <TableHead className="text-right">Diferencia</TableHead>
                  <TableHead>Motivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closed.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.code}</TableCell>
                    <TableCell>{s.userName}</TableCell>
                    <TableCell className="text-right">{formatMoney(s.expectedCashPen)}</TableCell>
                    <TableCell className="text-right">
                      {s.countedCashPen === null ? '—' : formatMoney(s.countedCashPen)}
                    </TableCell>
                    <TableCell
                      className={
                        s.differencePen !== null && !new Decimal(s.differencePen).isZero()
                          ? 'text-right text-destructive'
                          : 'text-right'
                      }
                    >
                      {s.differencePen === null ? '—' : formatMoney(s.differencePen)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.closingNotes ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <ReasonDialog
        open={voiding !== null}
        onOpenChange={(o) => {
          if (!o) setVoiding(null);
        }}
        title={`Anular la venta ${voiding?.code ?? ''}`}
        description="Se revierte el cobro, se deshace el comprobante (baja o nota de crédito según corresponda), vuelve el stock al almacén y se anula el pedido. Solo funciona con el comprobante ya aceptado por SUNAT."
        confirmLabel="Anular la venta"
        pending={voidSale.isPending}
        onConfirm={(reason) => {
          if (voiding) voidSale.mutate({ id: voiding.id, reason });
        }}
      />
    </RoleGate>
  );
}
