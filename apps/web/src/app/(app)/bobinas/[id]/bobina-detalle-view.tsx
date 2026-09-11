'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  COIL_SPLIT_STATUS_LABELS,
  INVENTORY_MOVEMENT_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  COIL_STATUS_LABELS,
  CURRENCY_LABELS,
  Decimal,
  PRODUCTION_ORDER_STATUS_LABELS,
  Role,
  type CoilConsumptionDto,
  type CoilDto,
  type CoilSplitDto,
  type InventoryMovementDto,
  type PaginatedResult,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import {
  formatMoney,
  formatQty,
  formatTimestampDate,
  isPositiveDecimal,
  unitSymbol,
} from '@/lib/format';
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
import { CoilCloseDialog } from './coil-close-dialog';
import { CoilEditDialog } from './coil-edit-dialog';
import { CoilScrapDialog } from './coil-scrap-dialog';
import { CoilSplitDialog } from './coil-split-dialog';
import { cn, LINK_CLASSNAME } from '@/lib/utils';

type PendingAction =
  | { kind: 'cancel-coil' }
  | { kind: 'revert-split'; splitId: string; label: string }
  | { kind: 'cancel-scrap'; movementId: string; qty: string }
  /**
   * D-164: reabrir. `qty` son los kilos que el cierre liquidó y que vuelven al kardex, o
   * `null` cuando no hay ajuste que revertir (o el kardex todavía no cargó): el motivo se
   * pide igual, y lo único que cambia es el texto del diálogo.
   */
  | { kind: 'reopen'; qty: string | null };

/**
 * Detalle de una bobina (RF-15..RF-21): datos, hijas, kardex y las acciones de Fase 2b
 * según el rol (§3.4). SUPERVISOR_PLANTA parte, merma y cierra; anular la bobina y
 * cambiar su moneda o su costo son de ADMINISTRADOR.
 */
export function BobinaDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const [dialog, setDialog] = useState<'split' | 'scrap' | 'edit' | 'close' | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const coil = useQuery({ queryKey: ['coil', id], queryFn: () => api<CoilDto>(`/coils/${id}`) });
  const splits = useQuery({
    queryKey: ['coil', id, 'splits'],
    queryFn: () => api<CoilSplitDto[]>(`/coils/${id}/splits`),
  });
  // D-172 (T4): la otra punta del link bidireccional — el detalle de la OP ya muestra sus
  // bobinas montadas, esto muestra qué OP (y qué pedido detrás) montaron esta bobina.
  const consumptions = useQuery({
    queryKey: ['coil', id, 'consumptions'],
    queryFn: () => api<CoilConsumptionDto[]>(`/coils/${id}/consumptions`),
  });
  const movements = useQuery({
    queryKey: ['inventory', 'movements', `itemId=${id}`],
    // El kardex de un solo ítem no pagina (calcula el saldo corrido): `PaginatedResult`
    // acá siempre trae todo el historial en una sola "página".
    queryFn: () =>
      api<PaginatedResult<InventoryMovementDto>>(`/inventory/movements?itemType=COIL&itemId=${id}`),
  });
  const movementRows = movements.data?.items ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['coil', id] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    // Anular o partir una bobina cambia el estado de la compra que la creó y su lista.
    void queryClient.invalidateQueries({ queryKey: ['purchase'] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
  };

  const runAction = useMutation({
    mutationFn: ({
      action,
      reason,
      operationDate,
    }: {
      action: PendingAction;
      reason: string;
      operationDate: string | undefined;
    }) => {
      const body = { reason, operationDate };
      if (action.kind === 'cancel-coil') {
        return api(`/coils/${id}/cancel`, { method: 'POST', body });
      }
      if (action.kind === 'revert-split') {
        return api(`/coils/splits/${action.splitId}/revert`, { method: 'POST', body });
      }
      if (action.kind === 'reopen') {
        return api(`/coils/${id}/status`, {
          method: 'POST',
          body: { status: 'OPEN', ...body },
        });
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

  if (coil.isPending) return <Skeleton className="h-64 w-full" />;
  if (coil.isError || !coil.data) {
    return <p className="text-destructive">No se pudo cargar la bobina.</p>;
  }

  const c = coil.data;
  const isOpen = c.status === 'OPEN';
  const hasStock = isPositiveDecimal(c.availableKg);
  const canOperate = isOpen && hasStock;
  /**
   * D-164: el ajuste que reabrir va a revertir, si lo hay. Solo sirve para **decir cuántos
   * kilos vuelven** en el diálogo; que haya o no motivo no depende de esto (ver abajo).
   *
   * El criterio es el mismo que aplica el API: el ajuste se revierte únicamente si es el
   * **último movimiento del kardex**, a secas, y no fue anulado todavía. `movementRows` viene
   * del más reciente al más antiguo —así lo pinta la tabla—, así que ese movimiento es el
   * **primero** de la lista.
   */
  const lastMovement = movementRows[0];
  const liveCloseAdjustment =
    lastMovement?.refType === 'CLOSE_ADJUSTMENT' && !lastMovement.reversedById
      ? lastMovement
      : undefined;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold">{c.code}</h1>
          <p className="text-xs text-muted-foreground">
            {c.typeKey} · {BUSINESS_LINE_LABELS[c.businessLine]} · {c.supplierName}
            {c.parentCoilId && c.parentCoilCode && (
              <>
                {' · hija de '}
                <Link className={LINK_CLASSNAME} href={`/bobinas/${c.parentCoilId}`}>
                  {c.parentCoilCode}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isOpen ? 'secondary' : 'outline'}>{COIL_STATUS_LABELS[c.status]}</Badge>
          {/* T6 (D-173): igual que el PDF de planta (D-149), descarga directa contra el API. */}
          <Button variant="outline" asChild>
            <a href={`/api/coils/${id}/pdf`}>Descargar PDF</a>
          </Button>
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
              disabled={runAction.isPending}
              onClick={() => {
                // D-164: cerrar **siempre** pregunta cuánto queda, también con el saldo en
                // cero. Es la misma pregunta en los dos casos, el diálogo muestra "no se
                // liquida nada" cuando no hay nada, y es lo único que deja declarar un
                // sobrante sobre una bobina que el kardex ya dio por consumida.
                //
                // Reabrir **también** pasa siempre por el diálogo de motivo, aunque no haya
                // ajuste que revertir. Decidirlo mirando el kardex era un error: mientras esa
                // consulta carga —o si falló, o durante el refetch posterior al cierre—
                // `movementRows` está vacío, así que se mandaba un `OPEN` sin motivo y el API
                // lo rechazaba pidiendo algo que la pantalla nunca había ofrecido; con el
                // kardex caído, la bobina no se podía reabrir. El motivo de más no hace daño
                // cuando no hay nada que deshacer, y el kardex solo decide **el texto**.
                if (isOpen) {
                  setDialog('close');
                } else {
                  setPending({ kind: 'reopen', qty: liveCloseAdjustment?.qty ?? null });
                }
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
            {/* D-164: el promedio del kardex, que puede diferir del costo de compra tras un
                landed cost (D-043) o un partido, y es con el que se valoriza lo que salga. */}
            <Row label="Promedio del kardex" value={`${formatMoney(c.avgCostPen, 'PEN', 4)}/kg`} />
            <Row
              label="Saldo valorizado"
              value={formatMoney(new Decimal(c.availableKg).times(c.avgCostPen).toFixed(4))}
            />
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
                  <Link className={LINK_CLASSNAME} href={`/compras/${c.purchaseId}`}>
                    {c.purchaseLabel}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row label="Alta" value={formatTimestampDate(c.createdAt)} />
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
              <QueryStates query={splits} colSpan={6} error="No se pudieron cargar los partidos." />
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
                          className={cn('font-mono text-xs', LINK_CLASSNAME)}
                          href={`/bobinas/${child.id}`}
                        >
                          {child.code} ({child.widthMm} mm · {formatQty(child.weightKg, 'kg')})
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
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Órdenes de producción</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Orden</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead className="text-right">Asignado</TableHead>
                <TableHead className="text-right">Consumido</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <QueryStates
                query={consumptions}
                colSpan={6}
                error="No se pudieron cargar las órdenes de producción."
              />
              {consumptions.data?.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono">
                    <Link className={LINK_CLASSNAME} href={`/produccion/${c.productionOrderId}`}>
                      {c.productionOrderCode}
                    </Link>
                  </TableCell>
                  <TableCell>{c.productSku}</TableCell>
                  <TableCell>
                    {c.salesOrderId ? (
                      <>
                        <Link className={LINK_CLASSNAME} href={`/pedidos/${c.salesOrderId}`}>
                          {c.salesOrderCode}
                        </Link>
                        {c.customerName && (
                          <span className="text-muted-foreground"> · {c.customerName}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Sin pedido</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatQty(c.assignedKg, 'kg')}</TableCell>
                  <TableCell className="text-right">{formatQty(c.consumedKg, 'kg')}</TableCell>
                  <TableCell>{PRODUCTION_ORDER_STATUS_LABELS[c.productionOrderStatus]}</TableCell>
                </TableRow>
              ))}
              {consumptions.isSuccess && consumptions.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Ninguna orden de producción montó esta bobina todavía.
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
              <QueryStates query={movements} colSpan={7} error="No se pudo cargar el kardex." />
              {movementRows.map((m) => (
                <TableRow key={m.id} className={m.reversedById ? 'opacity-60' : undefined}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(m.at).toLocaleString('es-PE')}
                  </TableCell>
                  <TableCell>
                    {INVENTORY_MOVEMENT_TYPE_LABELS[m.type]}
                    {m.reversalOfId && (
                      <span className="ml-2 text-xs text-muted-foreground">anulación</span>
                    )}
                  </TableCell>
                  <TableCell>{INVENTORY_REF_TYPE_LABELS[m.refType]}</TableCell>
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
                        bobina o la compra, un partido se revierte entero (RF-16) y el ajuste
                        del cierre se deshace reabriendo la bobina (D-164), no por RF-18. */}
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
              {movements.isSuccess && movementRows.length === 0 && (
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
      <CoilCloseDialog
        coil={c}
        open={dialog === 'close'}
        onOpenChange={(open) => {
          setDialog(open ? 'close' : null);
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
        confirmLabel={pending?.kind === 'reopen' ? 'Sí, reabrir' : 'Sí, anular'}
        pending={runAction.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          if (pending) runAction.mutate({ action: pending, reason, operationDate });
        }}
      />
    </RoleGate>
  );
}

function pendingTitle(action: PendingAction | null): string {
  if (action?.kind === 'revert-split') return 'Revertir el partido';
  if (action?.kind === 'cancel-scrap') return 'Anular la merma';
  if (action?.kind === 'reopen') return 'Reabrir la bobina';
  return 'Anular la bobina';
}

function pendingDescription(action: PendingAction | null): string {
  if (action?.kind === 'revert-split') {
    return `Las bobinas hijas (${action.label}) quedan anuladas y su peso vuelve a la madre. Solo se puede si ninguna hija se movió después.`;
  }
  if (action?.kind === 'cancel-scrap') {
    return `Se devuelven ${action.qty} kg al saldo con un movimiento inverso. El movimiento original no se borra.`;
  }
  if (action?.kind === 'reopen') {
    return action.qty === null
      ? 'La bobina vuelve a estar disponible para producción y partido. Si su cierre había liquidado un remanente, esos kilos vuelven al saldo con un movimiento inverso (D-164).'
      : `Al cerrarla se liquidaron ${action.qty} kg: reabrirla los devuelve al saldo con un movimiento inverso (D-164). El ajuste original no se borra.`;
  }
  return 'La bobina queda anulada y su ingreso se revierte en el kardex. Solo se puede si no tiene ningún otro movimiento.';
}

/**
 * Fila de carga o de error dentro de una tabla. Sin esto, una consulta que falla deja
 * `data` en `undefined`: no se pinta ni una fila ni el mensaje de vacío (que exige
 * `length === 0`), y un kardex caído se ve igual que una bobina sin movimientos —justo
 * en la tabla que decide si algo se puede anular.
 */
function QueryStates({
  query,
  colSpan,
  error,
}: {
  query: { isPending: boolean; isError: boolean };
  colSpan: number;
  error: string;
}) {
  if (query.isPending) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan}>
          <Skeleton className="h-5 w-full" />
        </TableCell>
      </TableRow>
    );
  }
  if (query.isError) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} className="text-destructive">
          {error}
        </TableCell>
      </TableRow>
    );
  }
  return null;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
