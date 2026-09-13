'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  compareQueueRank,
  MAX_ORDER_TABS,
  ProductionOrderKind,
  Role,
  type ProductionOrderListItemDto,
  type ProductionQueueEntryDto,
  type QueueRankable,
  type RoofingBatchOrderDto,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { formatDate, formatQty, queueAgeLabel } from '@/lib/format';
import { useSession } from '@/lib/session';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { DrywallOrderPanel } from './drywall-order-panel';
import { useProductionQueue } from '@/components/production-queue';
import { OrderHistory } from '@/components/production/order-history';
import { DrywallOrderCard, LinesWithoutOrderCard } from './new-order-cards';
import { groupByPedido, seqOf, WITHOUT_SALES_ORDER } from './pedido-groups';
import { PedidoList } from './pedido-list';
import { PedidoPriorityControl } from './pedido-priority';
import { plantaHref } from './planta-links';
import {
  EMPTY_DRAFT,
  NO_NOTES,
  RoofingOrderPanel,
  StateBadge,
  stateOf,
  type OrderDraft,
  type SavedNotes,
} from './roofing-order-panel';

/**
 * El espacio de producción: **la única entrada a producir** (RF-39; D-155, D-159, D-160).
 *
 * Hasta D-159 había dos. `/planta` era la terminal —una orden por vez, elegida de una grilla—
 * y `/planta/producir` el espacio del pedido —una pestaña por orden—, y las dos hacían lo
 * mismo con la mitad de las herramientas cada una: la terminal montaba y cerraba pero no
 * mostraba las hermanas del pedido; el espacio mostraba las hermanas pero no cerraba. Quien
 * producía un pedido de cuatro líneas terminaba yendo y viniendo entre las dos, y ninguna de
 * las dos era la de verdad.
 *
 * Ahora es una sola pantalla. Desde F8-S3b/M2 se **entra por pedido**: la primera vista lista
 * los pedidos con producción pendiente y cada uno abre su propia vista de producción
 * (`?pedido=`), directa desde F8-S3c/M1: sin paso por una cola separada, la franja de chips
 * trae de una vez todas las órdenes del pedido con el workspace de la primera debajo. Adentro,
 * cada orden es una pestaña con su ciclo completo, y la clase de la orden decide qué panel se
 * dibuja —coberturas o perfiles—, que es la única diferencia real entre las dos ramas (D-087).
 *
 * El detalle de una orden (`/produccion/:id`) queda de **solo lectura**: costos, kardex y
 * correcciones. Producir es acá, y en un solo lugar.
 */

/** §3.4: producción es de ADMINISTRADOR y SUPERVISOR_PLANTA. */
const PLANT_ROLES = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY_ROOFING: RoofingBatchOrderDto[] = [];

/** Una orden del selector, de cualquiera de las dos ramas. */
interface WorkspaceOrder {
  orderId: string;
  code: string;
  kind: ProductionOrderKind;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  customerName: string | null;
  /** Segunda línea de la pestaña: qué falta producir. */
  subtitle: string;
  /**
   * F8-S3c/M1: lo que aportaba el card de «Cola de producción» que el chip absorbe —en cola
   * desde cuándo, kilos teóricos— para una orden todavía no iniciada. `null` si ya arrancó o
   * si es de perfiles (la cola de D-189 es solo de coberturas).
   */
  queueNote: string | null;
  /** Solo coberturas: el DTO completo que su panel necesita. */
  roofing: RoofingBatchOrderDto | null;
}

/** F8-S3c/M1: el ranking de la cola (D-189) para una fila del workspace, de cualquier rama. */
function rankOfRoofing(order: RoofingBatchOrderDto): QueueRankable {
  return {
    priority: order.priority,
    promisedDeliveryDate: order.promisedDeliveryDate,
    seq: order.seq,
  };
}

function rankOfDrywall(order: ProductionOrderListItemDto): QueueRankable {
  return {
    priority: order.priority,
    promisedDeliveryDate: order.promisedDeliveryDate,
    seq: seqOf(order.code),
  };
}

/**
 * F8-S3b/M2: `/planta` tiene cuatro formas, y la URL decide cuál (ver `plantaHref`).
 *
 * - sin parámetros: los **pedidos** con producción pendiente;
 * - `?pedido=`: la producción de ese pedido —todas sus órdenes, en chips—;
 * - `?op=` suelto: se resuelve al pedido de la orden, porque los enlaces viejos y los de otras
 *   pantallas («Producir esta orden») siguen existiendo;
 * - `?historial=1`: el historial de órdenes (D-190), como vista propia (F8-S3b/M4).
 */
export function PlantaView() {
  const params = useSearchParams();
  const pedido = params.get('pedido');
  const op = params.get('op');
  const focused = op !== null && UUID.test(op) ? op : null;

  let content: React.ReactNode;
  if (params.get('historial') === '1') {
    content = <HistoryView />;
  } else if (pedido !== null && (pedido === WITHOUT_SALES_ORDER || UUID.test(pedido))) {
    // `key`: cambiar de pedido es otra pantalla, con sus propios borradores y fijadas.
    content = <PedidoWorkspace key={pedido} pedido={pedido} focused={focused} />;
  } else if (focused !== null) {
    content = <ResolveOrder orderId={focused} />;
  } else {
    content = <PedidoOverview />;
  }
  return <RoleGate allow={PLANT_ROLES}>{content}</RoleGate>;
}

/**
 * Las tres lecturas de siempre del espacio de producción. Con un pedido concreto el batch se
 * pide filtrado; sin pedido —o para las corridas a stock, que el API no sabe filtrar— viene
 * entero y se acota en la pantalla.
 */
function usePlantaOrders(salesOrderId: string | null) {
  const roofing = useQuery({
    queryKey: ['roofing-batch', salesOrderId],
    queryFn: () =>
      api<RoofingBatchOrderDto[]>(
        `/production/roofing/batch${salesOrderId === null ? '' : `?salesOrderId=${salesOrderId}`}`,
      ),
  });
  // El API filtra por estado, porque traer las 500 más recientes para quedarse con tres es caro
  // en una tablet.
  const draftOrders = useQuery({
    queryKey: ['production-orders', 'planta', 'DRAFT'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=DRAFT'),
  });
  const inProgress = useQuery({
    queryKey: ['production-orders', 'planta', 'IN_PROGRESS'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=IN_PROGRESS'),
  });
  const pending = roofing.isPending || draftOrders.isPending || inProgress.isPending;
  // Memorizado: un arreglo nuevo en cada render invalidaba los `useMemo` de abajo y hacía correr
  // el efecto de la pestaña activa en cada render (revisión de F8-S3b).
  const drywall = useMemo(
    () =>
      [...(inProgress.data ?? []), ...(draftOrders.data ?? [])].filter(
        (o) => o.kind === ProductionOrderKind.DRYWALL,
      ),
    [inProgress.data, draftOrders.data],
  );
  return {
    roofing: roofing.data ?? EMPTY_ROOFING,
    drywall,
    pending,
    failed: roofing.isError || draftOrders.isError || inProgress.isError,
    /**
     * Alguna de las tres listas está viajando. Es distinto de `pending`, que solo es cierto la
     * primera vez: acá también cuenta el refetch que dispara crear, montar, reportar o cerrar.
     */
    refreshing: pending || roofing.isFetching || draftOrders.isFetching || inProgress.isFetching,
  };
}

function PlantaHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** La primera vista: pedidos con producción pendiente (F8-S3b/M2). */
function PedidoOverview() {
  const router = useRouter();
  const orders = usePlantaOrders(null);
  const queue = useProductionQueue();
  const groups = useMemo(
    () => groupByPedido(orders.roofing, orders.drywall, queue.data ?? []),
    [orders.roofing, orders.drywall, queue.data],
  );
  /**
   * F8-S3c/M2: la cotización de origen de cada pedido, con el mismo `/sales/orders` que ya
   * usan otros selectores (D-113) — no hay endpoint por lista de ids, y pedir el detalle de
   * cada pedido por separado sería el N+1 que `batchOrders` ya evita para las órdenes. Mismo
   * tope de `fetchAllForPicker` (200): con más pedidos pendientes que eso, los más nuevos se
   * quedan sin el link, igual que el selector de cliente (§ pendientes de PROGRESO.md).
   */
  const salesOrders = useQuery({
    queryKey: ['sales-orders', 'planta-quotations'],
    queryFn: () => fetchAllForPicker<SalesOrderListItemDto>('/sales/orders'),
  });
  const quotations = useMemo(() => {
    const map = new Map<string, { quotationId: string; quotationCode: string }>();
    for (const o of salesOrders.data ?? []) {
      if (o.quotationId !== null && o.quotationCode !== null) {
        map.set(o.id, { quotationId: o.quotationId, quotationCode: o.quotationCode });
      }
    }
    return map;
  }, [salesOrders.data]);

  return (
    <div className="grid gap-4">
      <PlantaHeader
        title="Producción"
        description="Pedidos con producción pendiente, primero los priorizados, después los vencidos y después por fecha de compromiso. Entra a un pedido para montar, reportar y cerrar sus órdenes."
        actions={
          <>
            <NewOrderDrawer
              onCreated={(orderId) => {
                // `?op=` suelto se resuelve al pedido de la orden recién creada.
                router.push(plantaHref({ op: orderId }));
              }}
            />
            <Button variant="outline" asChild>
              <Link href={plantaHref({ historial: true })}>Historial de órdenes</Link>
            </Button>
          </>
        }
      />
      {/*
        La lista sale de las órdenes abiertas; la cola solo agrega el detalle de lo no iniciado.
        Si la cola falla, planta sigue teniendo por dónde entrar a producir (revisión de F8-S3b).

        Tope conocido: el batch sin filtro trae hasta 500 órdenes de coberturas abiertas
        (`batchOrders`). Por encima, los pedidos de las más nuevas no aparecen acá.
      */}
      {queue.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            No se pudo cargar la cola de producción: las tarjetas no muestran sus órdenes sin
            iniciar.
          </AlertDescription>
        </Alert>
      )}
      <PedidoList
        groups={groups}
        pending={orders.pending}
        failed={orders.failed}
        quotations={quotations}
      />
    </div>
  );
}

/**
 * F8-S3b/M4: abrir una orden nueva dejó de ser una sección plegable en línea y pasó a un
 * drawer. Es lo excepcional (D-160) y, abierto en la página, empujaba la lista hacia abajo;
 * el drawer mantiene la lista a la vista detrás.
 */
function NewOrderDrawer({ onCreated }: { onCreated: (orderId: string) => void }) {
  const [open, setOpen] = useState(false);
  const created = (orderId: string) => {
    setOpen(false);
    onCreated(orderId);
  };
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline">Abrir una orden nueva</Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-4 data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="p-0">
          <SheetTitle>Abrir una orden nueva</SheetTitle>
          <SheetDescription>
            Confirmar un pedido ya crea sus órdenes de coberturas. Acá se reabre la de una línea que
            perdió la suya o se abre una corrida de perfiles.
          </SheetDescription>
        </SheetHeader>
        {/*
          D-171: la tarjeta «Nueva orden de coberturas a stock» se fue con la puerta que cerró
          en el API. Una cobertura —plancha incluida— nace del pedido que reserva su material.
        */}
        <div className="grid gap-4">
          <LinesWithoutOrderCard onCreated={created} />
          <DrywallOrderCard onCreated={created} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** El historial de órdenes (D-190) como vista propia (F8-S3b/M4), no como sección plegable. */
function HistoryView() {
  return (
    <div className="grid gap-4">
      <PlantaHeader
        title="Historial de órdenes"
        description="Todas las órdenes de producción, de las dos líneas: cerradas, anuladas y corridas a stock incluidas."
        actions={
          <Button variant="outline" asChild>
            <Link href="/planta">Volver a producción</Link>
          </Button>
        }
      />
      <OrderHistory />
    </div>
  );
}

/**
 * `?op=` sin pedido: se busca la orden entre las abiertas y se reemplaza la dirección por la
 * de su pedido. Una orden que ya no está abierta no tiene nada que producir: se dice, y se
 * ofrece su detalle.
 */
function ResolveOrder({ orderId }: { orderId: string }) {
  const router = useRouter();
  const orders = usePlantaOrders(null);
  const found =
    orders.roofing.find((o) => o.orderId === orderId) ??
    orders.drywall.find((o) => o.id === orderId) ??
    null;

  useEffect(() => {
    if (found === null) return;
    router.replace(plantaHref({ pedido: found.salesOrderId ?? WITHOUT_SALES_ORDER, op: orderId }));
  }, [found, orderId, router]);

  if (orders.failed) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudieron cargar las órdenes abiertas.</AlertDescription>
      </Alert>
    );
  }
  if (found !== null || orders.refreshing) return <Skeleton className="h-64 w-full" />;
  return (
    <Alert>
      <AlertDescription>
        Esa orden no está abierta, así que no hay nada que producir.{' '}
        <Link className="underline" href={`/produccion/${orderId}`}>
          Ver su detalle
        </Link>{' '}
        o{' '}
        <Link className="underline" href="/planta">
          volver a producción
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}

/**
 * La producción de **un pedido** (F8-S3b/M2, directa desde F8-S3c/M1): lo que antes era
 * `/planta` entero, acotado. Arriba el resumen del pedido con su prioridad; abajo, sin ningún
 * paso intermedio, la franja de **todas** las órdenes abiertas del pedido —iniciadas o no—,
 * en el orden de `compareQueueRank` (D-189), con el workspace de la primera debajo.
 *
 * Hasta F8-S3c había un card de «Cola de producción» separado, solo con lo no iniciado, y
 * había que elegir de ahí antes de ver el workspace. Con tres órdenes eso era un paso de más:
 * ahora las tres son chips desde que se entra, y lo que la cola aportaba de más —en cola desde
 * cuándo, kilos teóricos— se absorbe en el chip de la orden que todavía no arrancó
 * (`queueNote`, F8-S3c/M1).
 */
function PedidoWorkspace({ pedido, focused }: { pedido: string; focused: string | null }) {
  const salesOrderId = pedido === WITHOUT_SALES_ORDER ? null : pedido;
  const isAdmin = useSession().user.role === Role.ADMINISTRADOR;
  const [activeId, setActiveId] = useState<string | null>(focused);
  /** D-124: día de negocio de todo lo que se reporte en esta sesión. Solo lo ve un admin. */
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  /**
   * Los borradores y los avisos viven acá y no en la pestaña **a propósito**: con estado
   * local, saltar a otra orden para verificar de qué bobina salió algo y volver borraba lo
   * transcripto sin ningún aviso.
   */
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>({});
  const [saved, setSaved] = useState<Record<string, SavedNotes>>({});

  const router = useRouter();
  const orders = usePlantaOrders(salesOrderId);
  const { refreshing, pending, failed } = orders;
  const queue = useProductionQueue();
  const belongs = (id: string | null) => id === salesOrderId;
  const pedidoRoofing = useMemo(
    () => orders.roofing.filter((o) => belongs(o.salesOrderId)),
    [orders.roofing, salesOrderId],
  );
  // Memorizado por el mismo motivo que `pedidoRoofing`: sin esto, `queueByOrder` y `rows` se
  // recalculaban en cada render y disparaban de nuevo los efectos que dependen de `rows`
  // (revisión de F8-S3c).
  const pedidoQueue = useMemo(
    () => (queue.data ?? []).filter((e) => belongs(e.salesOrderId)),
    [queue.data, salesOrderId],
  );
  const queueByOrder = useMemo(
    () => new Map(pedidoQueue.map((e) => [e.orderId, e])),
    [pedidoQueue],
  );

  /**
   * La orden elegida queda en `?op=`: recargar la vuelve a fijar.
   *
   * **Elegir chip también escribe `?op=`**, no solo abrir desde otra pantalla. Si solo lo
   * hiciera esa otra pantalla, la navegación de «abrir B» podía llegar después de un clic en el
   * chip A y el efecto de `?op=` le devolvía la B a quien ya había elegido la A. Con las dos
   * escribiendo, la última elección es también la última navegación, y gana.
   */
  const selectOrder = (orderId: string) => {
    setActiveId(orderId);
    // Sin comparar contra `focused`: ese valor puede ser el de antes de una navegación todavía
    // en vuelo, y saltarse el `replace` era exactamente la carrera que esto viene a cerrar.
    router.replace(plantaHref({ pedido, op: orderId }), { scroll: false });
  };

  const rows = useMemo<WorkspaceOrder[]>(() => {
    // F8-S3c/M1: la franja de chips es **todas** las órdenes abiertas del pedido, iniciadas o
    // no —ya no hay un paso previo por la cola—, en el orden de `compareQueueRank` (D-189).
    // `pedidoRoofing` no trae ese orden (la API lo da por `seq`), así que se ordena acá.
    const roofingEntries = pedidoRoofing.map((o) => ({
      rank: rankOfRoofing(o),
      row: toRoofingRow(o, queueByOrder.get(o.orderId) ?? null),
    }));
    const drywallEntries = orders.drywall
      .filter((o) => belongs(o.salesOrderId))
      .map((o) => ({ rank: rankOfDrywall(o), row: toDrywallRow(o) }));
    return [...roofingEntries, ...drywallEntries]
      .sort((a, b) => compareQueueRank(a.rank, b.rank))
      .map((e) => e.row);
  }, [pedidoRoofing, orders.drywall, salesOrderId, queueByOrder]);

  /**
   * `?op=` **se re-lee cuando cambia**, no solo al montar: con dos enlaces «Producir esta
   * orden» en la app, navegar de `?op=A` a `?op=B` no desmonta esta ruta y la pantalla se
   * quedaba en la orden anterior. Es el mismo efecto que tenía la terminal antes de D-160.
   */
  useEffect(() => {
    if (focused !== null) setActiveId(focused);
  }, [focused]);

  /**
   * La pestaña activa se elige sola la primera vez y se recompone si la orden que estaba
   * abierta desaparece de la lista (se cerró, se anuló).
   *
   * **Nada de esto corre mientras las listas viajan**, y ese guardia es la mitad del efecto:
   * durante el primer render `rows` está vacío y el `?op=` que vino por URL se descartaba
   * —la pantalla abría la primera orden en vez de la pedida, y solo con la caché fría, así
   * que parecía un defecto de red—; y tras crear una orden, el refetch todavía no la trae,
   * así que «crear» terminaba abriendo otra con el toast nombrando la que no se ve.
   */
  useEffect(() => {
    if (refreshing) return;
    if (rows.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId === null || !rows.some((r) => r.orderId === activeId)) {
      setActiveId(rows[0]?.orderId ?? null);
    }
  }, [rows, activeId, refreshing]);

  /**
   * Un `?op=` que no está entre las órdenes del pedido (cerrada, anulada, de otro pedido) se
   * avisa en vez de caer callado en la primera pestaña. Se decide **una vez por `?op=`**, con
   * las listas ya cargadas: abrir desde la cola también escribe `?op=`, y cerrar esa orden
   * después no es un enlace roto, es el trabajo terminado.
   */
  const [checkedFocus, setCheckedFocus] = useState<{ id: string; missing: boolean } | null>(null);
  useEffect(() => {
    if (refreshing || focused === null || checkedFocus?.id === focused) return;
    setCheckedFocus({ id: focused, missing: !rows.some((r) => r.orderId === focused) });
  }, [refreshing, focused, rows, checkedFocus]);
  const focusMissing = checkedFocus !== null && checkedFocus.id === focused && checkedFocus.missing;

  const active = rows.find((r) => r.orderId === activeId) ?? null;
  const roofingRows = rows.filter((r) => r.roofing !== null);
  const done = roofingRows.filter(
    (r) => r.roofing !== null && stateOf(r.roofing) === 'reportada',
  ).length;
  const asList = rows.length > MAX_ORDER_TABS;
  const group =
    groupByPedido(
      pedidoRoofing,
      orders.drywall.filter((o) => belongs(o.salesOrderId)),
      pedidoQueue,
    )[0] ?? null;
  const salesOrderCode = group?.salesOrderCode ?? null;

  return (
    <div className="grid gap-4">
      <PlantaHeader
        title={
          salesOrderId === null ? 'Órdenes sin pedido' : `Producir ${salesOrderCode ?? 'el pedido'}`
        }
        description={
          <>
            {salesOrderId === null
              ? 'Corridas a stock, sin pedido detrás. Cada orden monta su material, reporta lo suyo y se cierra por separado.'
              : 'Todas las órdenes del pedido, iniciadas o no. Monta la bobina y reporta sin salir de acá; cada orden se guarda por su cuenta.'}
            {salesOrderId !== null && group?.customerName && <> · {group.customerName}</>}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/planta">Todos los pedidos</Link>
            </Button>
            {salesOrderId !== null && (
              <Button variant="outline" asChild>
                <Link href={`/pedidos/${salesOrderId}`}>Ver pedido</Link>
              </Button>
            )}
          </>
        }
      />

      {group !== null && salesOrderId !== null && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <div className="grid gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  Compromiso:{' '}
                  {group.promisedDeliveryDate
                    ? formatDate(group.promisedDeliveryDate)
                    : 'sin fecha'}
                </span>
                {group.overdue && <Badge variant="destructive">Vencido</Badge>}
                {group.prioritized > 0 && (
                  <Badge>
                    {group.prioritized === group.roofing.length
                      ? 'Prioridad'
                      : `Prioridad en ${String(group.prioritized)} de ${String(group.roofing.length)} órdenes`}
                  </Badge>
                )}
              </div>
              <span className="text-muted-foreground">
                {group.roofing.length > 0 && (
                  <>
                    {formatQty(group.reportedMeters, 'm')} de {formatQty(group.planMeters, 'm')}{' '}
                    reportados ·{' '}
                  </>
                )}
                {group.counts.total}{' '}
                {group.counts.total === 1 ? 'orden abierta' : 'órdenes abiertas'}
              </span>
            </div>
            {/* La prioridad se asigna al pedido y se propaga a sus órdenes (F8-S3b/M2). */}
            {isAdmin && salesOrderCode !== null && (
              <PedidoPriorityControl salesOrderCode={salesOrderCode} orders={group.roofing} />
            )}
          </CardContent>
        </Card>
      )}

      {pending && <Skeleton className="h-64 w-full" />}
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>No se pudieron cargar las órdenes abiertas.</AlertDescription>
        </Alert>
      )}
      {!failed && focusMissing && (
        <Alert>
          <AlertDescription>
            La orden del enlace no está abierta en este pedido.{' '}
            <Link className="underline" href={`/produccion/${checkedFocus.id}`}>
              Ver su detalle
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      {!pending && !failed && rows.length === 0 && (
        <Alert>
          <AlertDescription>
            Este pedido no tiene órdenes abiertas. Genéralas desde el detalle del pedido.
          </AlertDescription>
        </Alert>
      )}

      {rows.length > 0 && (
        <>
          {roofingRows.length > 0 && <Progress done={done} total={roofingRows.length} />}
          <div
            className={
              asList ? 'grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr] lg:items-start' : 'grid gap-4'
            }
          >
            <OrderPicker rows={rows} activeId={activeId} asList={asList} onSelect={selectOrder} />
            {active?.roofing && (
              <RoofingOrderPanel
                key={active.orderId}
                order={active.roofing}
                asList={asList}
                refreshing={refreshing}
                draft={drafts[active.orderId] ?? EMPTY_DRAFT}
                notes={saved[active.orderId] ?? NO_NOTES}
                operationDate={operationDate}
                onOperationDate={setOperationDate}
                onDraft={(patch) => {
                  setDrafts((prev) => ({
                    ...prev,
                    [active.orderId]: { ...EMPTY_DRAFT, ...prev[active.orderId], ...patch },
                  }));
                }}
                onNotes={(next) => {
                  setSaved((prev) => ({ ...prev, [active.orderId]: next }));
                }}
              />
            )}
            {active?.roofing === null && (
              <DrywallOrderPanel key={active.orderId} orderId={active.orderId} asList={asList} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function toRoofingRow(
  order: RoofingBatchOrderDto,
  queueEntry: ProductionQueueEntryDto | null,
): WorkspaceOrder {
  return {
    orderId: order.orderId,
    code: order.code,
    kind: ProductionOrderKind.ROOFING,
    salesOrderId: order.salesOrderId,
    salesOrderCode: order.salesOrderCode,
    customerName: order.customerName,
    // El cliente va en la pestaña **siempre que exista**, no solo con `?pedido=`: sin él, la
    // lista de todas las órdenes abiertas es una columna de códigos de OP y SKU, y para saber
    // de quién es cada corrida había que abrirla. La terminal vieja lo mostraba siempre.
    subtitle:
      `${order.productSku} · faltan ${order.remainingMeters} m` +
      (order.customerName === null ? '' : ` · ${order.customerName}`),
    queueNote: queueEntry === null ? null : queueNoteOf(queueEntry),
    roofing: order,
  };
}

function queueNoteOf(entry: ProductionQueueEntryDto): string {
  const parts = [`en cola desde ${queueAgeLabel(entry.createdAt)}`];
  if (entry.theoreticalKg !== null) parts.push(`${formatQty(entry.theoreticalKg, 'kg')} teóricos`);
  return parts.join(' · ');
}

function toDrywallRow(order: ProductionOrderListItemDto): WorkspaceOrder {
  return {
    orderId: order.id,
    code: order.code,
    kind: order.kind,
    salesOrderId: order.salesOrderId,
    salesOrderCode: order.salesOrderCode,
    customerName: order.customerName,
    subtitle:
      `${order.productSku} · ${String(order.piecesReported)} piezas` +
      (order.targetPieces === null ? '' : ` de ${String(order.targetPieces)}`) +
      ` · ${formatQty(order.assignedKg, 'kg')} montados` +
      (order.customerName === null ? '' : ` · ${order.customerName}`),
    // La cola de D-189 es solo de coberturas: una corrida de perfiles nunca la tuvo.
    queueNote: null,
    roofing: null,
  };
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <Card>
      <CardContent className="grid gap-2 pt-6">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {done} de {total}{' '}
            {total === 1 ? 'orden con su plan cubierto' : 'órdenes con su plan cubierto'}
          </span>
          <span className="tabular-nums text-muted-foreground">{pct} %</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Órdenes reportadas"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${String(pct)}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Pestañas hasta `MAX_ORDER_TABS`, lista lateral por encima. El corte no es estético: con
 * ocho pestañas en una tablet hay que **buscar** la orden en vez de verla, que es
 * exactamente el trabajo que esta pantalla vino a sacar del medio.
 *
 * Con la forma de lista deja de anunciarse como `tablist`: la semántica de pestañas trae
 * expectativas de teclado (flechas para moverse entre ellas) que una lista lateral no
 * cumple, y anunciarla igual sería mentirle al lector de pantalla.
 */
function OrderPicker({
  rows,
  activeId,
  asList,
  onSelect,
}: {
  rows: readonly WorkspaceOrder[];
  activeId: string | null;
  asList: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role={asList ? undefined : 'tablist'}
      aria-label="Órdenes del pedido"
      className={asList ? 'grid gap-2' : 'flex flex-wrap gap-2'}
    >
      {rows.map((row) => {
        const selected = row.orderId === activeId;
        return (
          <button
            key={row.orderId}
            type="button"
            id={`tab-${row.orderId}`}
            role={asList ? undefined : 'tab'}
            aria-selected={asList ? undefined : selected}
            aria-controls={`panel-${row.orderId}`}
            aria-current={asList ? selected : undefined}
            onClick={() => {
              onSelect(row.orderId);
            }}
            className={`rounded-lg border px-3 py-2 text-left ${
              selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'
            } ${asList ? 'w-full' : ''}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium">{row.code}</span>
              {row.roofing ? (
                <StateBadge state={stateOf(row.roofing)} />
              ) : (
                <Badge variant="outline">Perfiles</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">{row.subtitle}</div>
            {row.queueNote !== null && (
              <div className="text-xs text-muted-foreground">{row.queueNote}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
