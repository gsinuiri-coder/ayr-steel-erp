'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MAX_REPORT_PIECES,
  ProductBomKind,
  type ProductBomDto,
  type ProductionOrderDto,
  type ReservationDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateProduction } from '@/lib/production-queries';
import { OperationDateField } from '@/components/operation-date-field';
import { QueueEntrySummary, useProductionQueue } from '@/components/production-queue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Las tres formas de **abrir** una orden de producción, juntas en un solo lugar (D-160).
 *
 * Estaban repartidas entre `planta-view.tsx` (perfiles) y `roofing-terminal.tsx` (coberturas),
 * que eran las dos mitades de la misma pantalla; al fundirse la terminal con el espacio de
 * producción, crear la orden dejó de ser el paso 1 de una pantalla y pasó a ser una sección
 * del workspace que se despliega cuando hace falta.
 *
 * Las tres son distintas porque el dominio las hace distintas: una cobertura a medida nace
 * del **pedido** que reserva el material (D-084), una plancha de catálogo nace de una meta a
 * stock (D-140), y un perfil de drywall nace del **producto** y su receta.
 */

/**
 * D-084: una OP de coberturas a medida no se crea eligiendo un producto, se crea eligiendo el
 * **pedido** que viene a cumplir. La lista son las reservas activas sobre bobina, que es
 * exactamente lo que un pedido de coberturas promete antes de fabricarse.
 */
export function RoofingQueueCard({ onCreated }: { onCreated: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const queue = useProductionQueue();

  // D-124: día en que arranca la corrida. Montar la bobina es custodia y no mueve kardex
  // (D-060), así que crear la orden solo necesita su fecha.
  const [orderDate, setOrderDate] = useState<string | undefined>(undefined);
  const create = useMutation({
    mutationFn: (reservationId: string) =>
      api<ProductionOrderDto>('/production/roofing', {
        method: 'POST',
        body: { reservationId, operationDate: orderDate },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada con el plan de corte del pedido`);
      invalidateProduction(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['production-queue'] });
      onCreated(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  const pending = queue.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Coberturas por fabricar</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          La cola ordena prioridad, luego semáforo de fecha prometida y luego el pedido más antiguo
          (RF-37, D-094). Una orden de coberturas nace del pedido y copia sus largos como plan de
          corte, que puedes ajustar antes y durante la corrida (RF-31, D-084).
        </p>
        {queue.isPending && <Skeleton className="h-16 w-full" />}
        {queue.isError && (
          <p className="text-sm text-destructive">No se pudieron cargar los pedidos pendientes.</p>
        )}
        {queue.isSuccess && pending.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hay pedidos de coberturas esperando producción.
          </p>
        )}
        {pending.map((entry) => (
          <div
            key={entry.reservationId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <QueueEntrySummary entry={entry} />
            <div className="grid justify-items-end gap-1">
              <Button
                className="h-12"
                aria-label={`Iniciar producción del pedido ${entry.salesOrderCode}`}
                disabled={create.isPending}
                onClick={() => {
                  create.mutate(entry.reservationId);
                }}
              >
                Iniciar producción
              </Button>
              <OperationDateField value={orderDate} onChange={setOrderDate} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Una corrida de perfiles de drywall: nace del producto y su receta, con meta opcional. */
export function DrywallOrderCard({ onCreated }: { onCreated: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [targetPieces, setTargetPieces] = useState('');
  /** D-066: pedido contra el que se fabrica. Vacío = corrida de stock, sin reserva detrás. */
  const [reservationId, setReservationId] = useState('');
  const [orderDate, setOrderDate] = useState<string | undefined>(undefined);

  const boms = useQuery({
    queryKey: ['production-boms'],
    queryFn: () => api<ProductBomDto[]>('/production/boms'),
  });
  /**
   * Reservas activas: los pedidos que esperan que planta fabrique (D-066).
   *
   * Sin esto la reserva no tenía consumidor en la UI y el guardrail se volvía en contra: al
   * confirmar un pedido, el material quedaba bloqueado para **toda** orden que no fuera la
   * nacida de esa reserva, y planta no tenía forma de crear esa orden.
   */
  const reservations = useQuery({
    queryKey: ['reservations', 'ACTIVE'],
    queryFn: () => api<ReservationDto[]>('/sales/reservations?status=ACTIVE'),
  });

  const create = useMutation({
    mutationFn: () =>
      api<ProductionOrderDto>('/production', {
        method: 'POST',
        body: {
          productId,
          operationDate: orderDate,
          ...(targetPieces.trim() ? { targetPieces: Number(targetPieces.trim()) } : {}),
          ...(reservationId ? { reservationId } : {}),
        },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada`);
      setProductId('');
      setTargetPieces('');
      setReservationId('');
      invalidateProduction(queryClient);
      onCreated(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  // Solo las recetas de drywall: una corrida de coberturas no se crea eligiendo el
  // producto (D-084), y ofrecerla acá terminaría en un 400 del API.
  const activeBoms = (boms.data ?? []).filter(
    (b) => b.isActive && b.kind === ProductBomKind.DRYWALL,
  );
  // Solo las reservas de pedidos que piden **este** perfil: el API rechaza cualquier otra
  // (una reserva solo autoriza a fabricar lo que su propio pedido encargó).
  const productReservations = (reservations.data ?? []).filter((r) =>
    r.orderProductIds.includes(productId),
  );
  const piecesValue = targetPieces.trim();
  // Las mismas cotas que el API (`piecesSchema`): 1 .. MAX_REPORT_PIECES enteras.
  const piecesInvalid =
    piecesValue !== '' &&
    (!/^\d+$/.test(piecesValue) ||
      Number(piecesValue) < 1 ||
      Number(piecesValue) > MAX_REPORT_PIECES);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Nueva orden de perfiles (drywall)</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-x-4 gap-y-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="planta-producto">Perfil a fabricar</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="planta-producto" className="h-12">
              <SelectValue placeholder="Elige el perfil" />
            </SelectTrigger>
            <SelectContent>
              {activeBoms.map((b) => (
                <SelectItem key={b.productId} value={b.productId}>
                  {b.productSku} — {b.productName}
                  {b.inputWidthMm !== null && <> ({b.inputWidthMm} mm)</>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="planta-meta">Meta de piezas (opcional)</Label>
          <Input
            id="planta-meta"
            inputMode="numeric"
            className="h-12 text-lg"
            value={targetPieces}
            onChange={(e) => {
              setTargetPieces(e.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Button
            className="h-12"
            disabled={!productId || piecesInvalid || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Creando…' : 'Crear orden'}
          </Button>
          <OperationDateField value={orderDate} onChange={setOrderDate} />
        </div>
        {productId !== '' && productReservations.length > 0 && (
          <div className="grid gap-2 sm:col-span-3">
            <Label htmlFor="planta-pedido">Pedido a atender (opcional)</Label>
            <Select value={reservationId} onValueChange={setReservationId}>
              <SelectTrigger id="planta-pedido" className="h-12">
                <SelectValue placeholder="Corrida de stock, sin pedido" />
              </SelectTrigger>
              <SelectContent>
                {productReservations.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.salesOrderCode} — {r.customerName} — {r.itemLabel} ({r.qty} {r.unit})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Con un pedido elegido, la orden puede montar el material que ese pedido reservó — que
              para cualquier otra orden está bloqueado.
            </p>
          </div>
        )}
        {boms.isPending && <Skeleton className="h-5 w-full sm:col-span-3" />}
        {boms.isError && (
          <p className="text-sm text-destructive sm:col-span-3">
            No se pudieron cargar las recetas de fabricación.
          </p>
        )}
        {boms.isSuccess && activeBoms.length === 0 && (
          <p className="text-sm text-muted-foreground sm:col-span-3">
            Ningún perfil tiene receta cargada todavía: pídesela a un administrador desde el
            catálogo.
          </p>
        )}
        {piecesInvalid && (
          <p className="text-sm text-destructive sm:col-span-3">
            La meta de piezas es un número entero entre 1 y {MAX_REPORT_PIECES}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
