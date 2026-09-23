'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describePieces,
  MAX_REPORT_PIECES,
  ProductBomKind,
  RoofingProductKind,
  toDecimal,
  type LineWithoutOrderDto,
  type ProductBomDto,
  type ProductDto,
  type ProductionOrderDto,
  type ReservationDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { OperationDateField } from '@/components/operation-date-field';
import {
  SEMAPHORE_LABEL,
  SEMAPHORE_VARIANT,
  useLinesWithoutOrder,
} from '@/components/production-queue';
import { Badge } from '@/components/ui/badge';
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
 * Las formas de **abrir** una orden de producción, juntas en un solo lugar (D-160).
 *
 * Estaban repartidas entre `planta-view.tsx` (perfiles) y `roofing-terminal.tsx` (coberturas),
 * que eran las dos mitades de la misma pantalla; al fundirse la terminal con el espacio de
 * producción, crear la orden dejó de ser el paso 1 de una pantalla y pasó a ser una sección
 * del workspace que se despliega cuando hace falta.
 *
 * Son distintas porque el dominio las hace distintas: una cobertura a medida nace del
 * **pedido** que reserva el material (D-084), un perfil de drywall nace del **producto** y su
 * receta, y un accesorio a stock (D-248) nace de una meta **y un largo**, porque se vende por
 * metro y no tiene uno fijo.
 */

/**
 * D-084: una OP de coberturas a medida no se crea eligiendo un producto, se crea eligiendo el
 * **pedido** que viene a cumplir. La lista son las líneas que reservan materia prima y no
 * tienen orden viva.
 *
 * D-189: esto dejó de ser la cola. Confirmar ya crea las órdenes (D-186); acá solo llega lo
 * que perdió la suya —una OP anulada devuelve la reserva— o un pedido anterior a D-186.
 */
export function LinesWithoutOrderCard({ onCreated }: { onCreated: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const queue = useLinesWithoutOrder();

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
      onCreated(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  const pending = queue.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Líneas de pedido sin orden</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Confirmar un pedido ya crea sus órdenes: acá solo aparecen las líneas cuya orden se anuló.
          La orden nueva copia los largos del pedido como plan de corte (RF-31, D-084).
        </p>
        {queue.isPending && <Skeleton className="h-16 w-full" />}
        {queue.isError && (
          <p className="text-sm text-destructive">No se pudieron cargar las líneas sin orden.</p>
        )}
        {queue.isSuccess && pending.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Todas las líneas de coberturas tienen su orden.
          </p>
        )}
        {pending.map((entry) => (
          <div
            key={entry.reservationId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <LineWithoutOrderSummary entry={entry} />
            <div className="grid justify-items-end gap-1">
              <Button
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

function LineWithoutOrderSummary({ entry }: { entry: LineWithoutOrderDto }) {
  return (
    <div className="grid gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono font-medium">{entry.salesOrderCode}</span>
        <Badge variant={SEMAPHORE_VARIANT[entry.semaphore]}>
          {SEMAPHORE_LABEL[entry.semaphore]}
        </Badge>
        <span className="text-sm">{entry.customerName}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {entry.productSku} — {entry.productName} · {describePieces(entry.pieces)}
        {entry.theoreticalKg !== null && <> · {formatQty(entry.theoreticalKg, 'kg')} teóricos</>} ·
        Prometida:{' '}
        {entry.promisedDeliveryDate ? formatDate(entry.promisedDeliveryDate) : 'sin fecha'}
      </div>
    </div>
  );
}

/**
 * D-248: una corrida de **accesorios a stock**.
 *
 * Es la cuarta forma de abrir una orden y no cabía en ninguna de las tres: un accesorio no
 * nace de un pedido (se produce para tener en almacén), no tiene receta como un perfil de
 * drywall, y no tiene largo fijo como una plancha —se vende por metro—. Así que la corrida
 * elige dos cosas que ninguna otra elige: **en qué largo** se produce y **cuántas piezas**.
 * Las pasadas salen de ahí cuando planta monte la bobina, porque recién entonces se sabe
 * cuántas piezas da cada una.
 */
export function AccessoryStockCard({ onCreated }: { onCreated: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [targetPieces, setTargetPieces] = useState('');
  const [lengthM, setLengthM] = useState('');
  const [orderDate, setOrderDate] = useState<string | undefined>(undefined);

  const products = useQuery({
    queryKey: ['catalog', 'accesorios'],
    queryFn: () => api<ProductDto[]>('/catalog'),
    select: (rows) =>
      rows.filter((p) => p.isActive && p.roofingKind === RoofingProductKind.ACCESORIO),
  });

  const create = useMutation({
    mutationFn: () =>
      api<ProductionOrderDto>('/production/roofing', {
        method: 'POST',
        body: {
          productId,
          targetPieces: Number(targetPieces.trim()),
          // El campo se tipea en metros y el API los pide en milímetros, igual que el resto
          // de la pantalla de coberturas (D-166).
          pieceLengthMm: toDecimal(lengthM.trim().replace(',', '.')).times(1000).toFixed(2),
          operationDate: orderDate,
        },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada para stock`);
      setProductId('');
      setTargetPieces('');
      setLengthM('');
      invalidateProduction(queryClient);
      onCreated(order.id);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear la orden'),
  });

  const chosen = (products.data ?? []).find((p) => p.id === productId) ?? null;
  const piecesValue = targetPieces.trim();
  const piecesInvalid =
    piecesValue === '' ||
    !/^\d+$/.test(piecesValue) ||
    Number(piecesValue) < 1 ||
    Number(piecesValue) > MAX_REPORT_PIECES;
  const lengthValue = lengthM.trim().replace(',', '.');
  const lengthInvalid = lengthValue === '' || !/^\d+(\.\d+)?$/.test(lengthValue);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Accesorios a stock</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-x-4 gap-y-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <p className="text-sm text-muted-foreground sm:col-span-4">
          Para tener en almacén, sin pedido detrás. La corrida elige el largo porque un accesorio se
          vende por metro y no tiene uno fijo; las piezas por pasada las decide la bobina que se
          monte.
        </p>
        <div className="grid gap-2">
          <Label htmlFor="planta-accesorio">Accesorio</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="planta-accesorio">
              <SelectValue placeholder="Elige el accesorio" />
            </SelectTrigger>
            <SelectContent>
              {(products.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                  {p.developmentMm !== null && <> (desarrollo {p.developmentMm} mm)</>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="planta-acc-largo">Largo (m)</Label>
          <Input
            id="planta-acc-largo"
            inputMode="decimal"
            placeholder="3.00"
            value={lengthM}
            onChange={(e) => {
              setLengthM(e.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="planta-acc-meta">Piezas</Label>
          <Input
            id="planta-acc-meta"
            inputMode="numeric"
            placeholder="12"
            value={targetPieces}
            onChange={(e) => {
              setTargetPieces(e.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Button
            disabled={!productId || piecesInvalid || lengthInvalid || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Creando…' : 'Crear orden'}
          </Button>
          <OperationDateField value={orderDate} onChange={setOrderDate} />
        </div>
        {chosen !== null && !piecesInvalid && !lengthInvalid && (
          <p className="text-sm text-muted-foreground sm:col-span-4">
            Plan: {piecesValue} piezas de {lengthValue} m ={' '}
            {toDecimal(lengthValue).times(Number(piecesValue)).toFixed(3)} ML
            {chosen.piecesPerPass !== null && (
              <>
                {' '}
                · con el ancho del catálogo, {Math.ceil(
                  Number(piecesValue) / chosen.piecesPerPass,
                )}{' '}
                pasadas
              </>
            )}
          </p>
        )}
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
        <CardTitle>Nueva orden de perfiles (drywall)</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-x-4 gap-y-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="planta-producto">Perfil a fabricar</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="planta-producto">
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
            value={targetPieces}
            onChange={(e) => {
              setTargetPieces(e.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Button
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
              <SelectTrigger id="planta-pedido">
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
