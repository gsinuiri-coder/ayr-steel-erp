'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  describePieces,
  type LineWithoutOrderDto,
  type ProductDto,
  type ProductionOrderDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { drywallProfilesOf } from '@/lib/drywall-profiles';
import { formatDate, formatQtyAsIs } from '@/lib/format';
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
 * stock (D-140), y un perfil de drywall nace del **SKU** (D-344: ya no hay receta).
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
    onError: (err) => toast.error(errorMessage(err, 'No se pudo crear la orden')),
  });

  const pending = queue.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Líneas de pedido sin orden</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Confirmar un pedido ya crea sus órdenes: aquí solo aparecen las líneas cuya orden se
          anuló. La orden nueva copia los largos del pedido como plan de corte.
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
        {entry.theoreticalKg !== null && (
          <> · {formatQtyAsIs(entry.theoreticalKg, 'kg')} teóricos</>
        )}{' '}
        · Prometida:{' '}
        {entry.promisedDeliveryDate ? formatDate(entry.promisedDeliveryDate) : 'sin fecha'}
      </div>
    </div>
  );
}

/**
 * Una corrida de perfiles de drywall: nace del SKU del perfil (D-344: el espesor y el ancho del
 * fleje son del SKU, ya no hay receta). D-599 (cc44): toda orden de perfiles es una **corrida de
 * stock**, sin pedido detrás —un pedido de perfiles se confirma solo con stock (D-598)— y D-601:
 * sin meta de piezas. El API sigue aceptando `reservationId` y `targetPieces` opcionales.
 */
export function DrywallOrderCard({ onCreated }: { onCreated: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [orderDate, setOrderDate] = useState<string | undefined>(undefined);

  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ProductDto[]>('/catalog'),
  });

  const create = useMutation({
    mutationFn: () =>
      api<ProductionOrderDto>('/production', {
        method: 'POST',
        body: { productId, operationDate: orderDate },
      }),
    onSuccess: (order) => {
      toast.success(`Orden ${order.code} creada`);
      setProductId('');
      invalidateProduction(queryClient);
      onCreated(order.id);
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo crear la orden')),
  });

  // Solo los perfiles de drywall con el SKU completo: una corrida de coberturas no se crea
  // eligiendo el producto (D-084), y uno sin espesor, ancho o peso terminaría en un 400 del API.
  const { ready: profiles, incomplete } = drywallProfilesOf(catalog.data ?? []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Nueva orden de perfiles (drywall)</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-x-4 gap-y-3 sm:grid-cols-[2fr_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="planta-producto">Perfil a fabricar</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="planta-producto">
              <SelectValue placeholder="Elige el perfil" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.productId} value={p.productId}>
                  {p.sku} — {p.name} ({p.widthMm} mm)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Button
            disabled={!productId || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Creando…' : 'Crear orden'}
          </Button>
          <OperationDateField value={orderDate} onChange={setOrderDate} />
        </div>
        <p className="text-sm text-muted-foreground sm:col-span-2">
          Corrida de stock: las piezas entran al almacén y los pedidos de perfiles se confirman
          contra ese stock.
        </p>
        {catalog.isPending && <Skeleton className="h-5 w-full sm:col-span-2" />}
        {catalog.isError && (
          <p className="text-sm text-destructive sm:col-span-2">
            No se pudo cargar el catálogo de perfiles.
          </p>
        )}
        {catalog.isSuccess && profiles.length === 0 && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Ningún perfil tiene el SKU completo todavía: un administrador tiene que cargar el
            espesor y el ancho del fleje, el largo y el peso desde el catálogo.
          </p>
        )}
        {catalog.isSuccess && profiles.length > 0 && incomplete.length > 0 && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            {incomplete.length === 1
              ? '1 perfil no aparece porque le falta'
              : `${String(incomplete.length)} perfiles no aparecen porque les falta`}{' '}
            espesor, ancho del fleje o peso en el catálogo.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
