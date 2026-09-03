'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  COIL_SPLIT_STATUS_LABELS,
  COIL_STATUS_LABELS,
  CURRENCY_LABELS,
  Role,
  type CoilDto,
  type CoilSplitDto,
  type InventoryMovementDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatQty, unitSymbol } from '@/lib/format';
import { useSession } from '@/lib/session';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
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
import { CoilEditDialog } from './coil-edit-dialog';
import { CoilScrapDialog } from './coil-scrap-dialog';
import { CoilSplitDialog } from './coil-split-dialog';

type PendingAction =
  | { kind: 'cancel-coil' }
  | { kind: 'revert-split'; splitId: string; label: string }
  | { kind: 'cancel-scrap'; movementId: string; qty: string };

/**
 * Detalle de una bobina (RF-15..RF-21): datos, hijas, kardex y las acciones de Fase 2b
 * según el rol (§3.4). SUPERVISOR_PLANTA parte, merma y cierra; anular la bobina y
 * cambiar su moneda o su costo son de ADMINISTRADOR.
 */
export function BobinaDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const [dialog, setDialog] = useState<'split' | 'scrap' | 'edit' | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const coil = useQuery({ queryKey: ['coil', id], queryFn: () => api<CoilDto>(`/coils/${id}`) });
  const splits = useQuery({
    queryKey: ['coil', id, 'splits'],
    queryFn: () => api<CoilSplitDto[]>(`/coils/${id}/splits`),
  });
  const movements = useQuery({
    queryKey: ['inventory', 'movements', `itemId=${id}`],
    queryFn: () => api<InventoryMovementDto[]>(`/inventory/movements?itemType=COIL&itemId=${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['coil', id] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };

  const runAction = useMutation({
    mutationFn: ({ action, reason }: { action: PendingAction; reason: string }) => {
      const body = { reason };
      if (action.kind === 'cancel-coil') {
        return api(`/coils/${id}/cancel`, { method: 'POST', body });
      }
      if (action.kind === 'revert-split') {
        return api(`/coils/splits/${action.splitId}/revert`, { method: 'POST', body });
      }
      return api(`/coils/scraps/${action.movementId}/cancel`, { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success('Listo: el kardex ya tiene el movimiento inverso');
      setPending(null);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo completar la operación'),
  });

  const setStatus = useMutation({
    mutationFn: (status: 'OPEN' | 'CLOSED') =>
      api<CoilDto>(`/coils/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: (_data, status) => {
      toast.success(status === 'CLOSED' ? 'Bobina cerrada' : 'Bobina reabierta');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar el estado'),
  });

  if (coil.isPending) return <Skeleton className="h-64 w-full" />;
  if (coil.isError || !coil.data) {
    return <p className="text-destructive">No se pudo cargar la bobina.</p>;
  }

  const c = coil.data;
  const isOpen = c.status === 'OPEN';
  const hasStock = Number.parseFloat(c.availableKg) > 0;
  const canOperate = isOpen && hasStock;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold">{c.code}</h1>
          <p className="text-sm text-muted-foreground">
            {c.typeKey} · {BUSINESS_LINE_LABELS[c.businessLine]} · {c.supplierName}
            {c.parentCoilCode && (
              <>
                {' · hija de '}
                <Link
                  className="underline underline-offset-4"
                  href={`/bobinas/${c.parentCoilId ?? ''}`}
                >
                  {c.parentCoilCode}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isOpen ? 'secondary' : 'outline'}>{COIL_STATUS_LABELS[c.status]}</Badge>
          <Button
            variant="outline"
            disabled={!canOperate}
            onClick={() => {
              setDialog('split');
            }}
          >
            Partir
          </Button>
          <Button
            variant="outline"
            disabled={c.status === 'CANCELLED' || !hasStock}
            onClick={() => {
              setDialog('scrap');
            }}
          >
            Registrar merma
          </Button>
          {c.status !== 'CANCELLED' && (
            <Button
              variant="outline"
              disabled={setStatus.isPending}
              onClick={() => {
                setStatus.mutate(isOpen ? 'CLOSED' : 'OPEN');
              }}
            >
              {isOpen ? 'Cerrar' : 'Abrir'}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={c.status === 'CANCELLED'}
            onClick={() => {
              setDialog('edit');
            }}
          >
            Editar
          </Button>
          {isAdmin && c.status !== 'CANCELLED' && (
            <Button
              variant="destructive"
              onClick={() => {
                setPending({ kind: 'cancel-coil' });
              }}
            >
              Anular
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Material</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Acabado" value={`${c.finishCode} — ${c.finishName}`} />
            <Row label="Espesor" value={`${c.thicknessMm} mm`} />
            <Row label="Ancho" value={`${c.widthMm} mm`} />
            <Row label="Peso de alta" value={formatQty(c.weightKg, 'kg')} />
            <Row label="Disponible" value={formatQty(c.availableKg, 'kg')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Costo</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row label="Moneda" value={CURRENCY_LABELS[c.currency]} />
            {c.currency !== 'PEN' && <Row label="Tipo de cambio" value={c.exchangeRate} />}
            <Row label="Costo por kg" value={formatMoney(c.unitCostPerKg, c.currency, 4)} />
            <Row label="Costo total" value={formatMoney(c.totalCost, c.currency)} />
            <Row label="Costo total en soles" value={formatMoney(c.totalCostPen)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Origen</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row
              label="Compra"
              value={
                c.purchaseId && c.purchaseLabel ? (
                  <Link className="underline underline-offset-4" href={`/compras/${c.purchaseId}`}>
                    {c.purchaseLabel}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row label="Alta" value={formatDate(c.createdAt.slice(0, 10))} />
            <Row label="Observaciones" value={c.notes ?? '—'} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Partidos (RF-15)</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Peso partido</TableHead>
                <TableHead className="text-right">Merma de corte</TableHead>
                <TableHead>Hijas</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {splits.data?.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(s.createdAt).toLocaleString('es-PE')}
                  </TableCell>
                  <TableCell className="text-right">{formatQty(s.splitWeightKg, 'kg')}</TableCell>
                  <TableCell className="text-right">
                    {s.kerfLossMm} mm · {formatQty(s.kerfLossKg, 'kg')}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {s.children.map((child) => (
                        <Link
                          key={child.id}
                          className="font-mono text-xs underline underline-offset-4"
                          href={`/bobinas/${child.id}`}
                        >
                          {child.code} ({child.widthMm} mm · {child.weightKg} kg)
                        </Link>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === 'ACTIVE' ? 'secondary' : 'outline'}>
                      {COIL_SPLIT_STATUS_LABELS[s.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {s.status === 'ACTIVE' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPending({
                            kind: 'revert-split',
                            splitId: s.id,
                            label: s.children.map((ch) => ch.code).join(', '),
                          });
                        }}
                      >
                        Revertir
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {splits.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Esta bobina no se partió todavía.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Kardex de la bobina (RF-53)</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/kardex?itemType=COIL&item=${id}`}>Ver kardex completo</Link>
          </Button>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Movimiento</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.data?.map((m) => (
                <TableRow key={m.id} className={m.reversedById ? 'opacity-60' : undefined}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(m.at).toLocaleString('es-PE')}
                  </TableCell>
                  <TableCell>
                    {m.type}
                    {m.reversalOfId && (
                      <span className="ml-2 text-xs text-muted-foreground">anulación</span>
                    )}
                  </TableCell>
                  <TableCell>{m.refType}</TableCell>
                  <TableCell className="text-right">
                    {m.type === 'ADJUST' ? '—' : formatQty(m.qty, unitSymbol(m.unit))}
                  </TableCell>
                  <TableCell className="text-right">
                    {m.balanceQty ? formatQty(m.balanceQty, unitSymbol(m.unit)) : '—'}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {m.notes ?? ''}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Solo la merma se anula desde acá: un ingreso se deshace anulando la
                        bobina o la compra, y un partido se revierte entero (RF-16). */}
                    {m.refType === 'SCRAP' && !m.reversalOfId && !m.reversedById && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPending({
                            kind: 'cancel-scrap',
                            movementId: m.id,
                            qty: m.qty,
                          });
                        }}
                      >
                        Anular merma
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {movements.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Sin movimientos.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CoilSplitDialog
        coil={c}
        open={dialog === 'split'}
        onOpenChange={(open) => {
          setDialog(open ? 'split' : null);
        }}
        onDone={invalidate}
      />
      <CoilScrapDialog
        coil={c}
        open={dialog === 'scrap'}
        onOpenChange={(open) => {
          setDialog(open ? 'scrap' : null);
        }}
        onDone={invalidate}
      />
      <CoilEditDialog
        coil={c}
        canEditCost={isAdmin}
        open={dialog === 'edit'}
        onOpenChange={(open) => {
          setDialog(open ? 'edit' : null);
        }}
        onDone={invalidate}
      />

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pendingTitle(pending)}
        description={pendingDescription(pending)}
        confirmLabel="Sí, anular"
        pending={runAction.isPending}
        onConfirm={(reason) => {
          if (pending) runAction.mutate({ action: pending, reason });
        }}
      />
    </RoleGate>
  );
}

function pendingTitle(action: PendingAction | null): string {
  if (action?.kind === 'revert-split') return 'Revertir el partido';
  if (action?.kind === 'cancel-scrap') return 'Anular la merma';
  return 'Anular la bobina';
}

function pendingDescription(action: PendingAction | null): string {
  if (action?.kind === 'revert-split') {
    return `Las bobinas hijas (${action.label}) quedan anuladas y su peso vuelve a la madre. Solo se puede si ninguna hija se movió después.`;
  }
  if (action?.kind === 'cancel-scrap') {
    return `Se devuelven ${action.qty} kg al saldo con un movimiento inverso. El movimiento original no se borra.`;
  }
  return 'La bobina queda anulada y su ingreso se revierte en el kardex. Solo se puede si no tiene ningún otro movimiento.';
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
