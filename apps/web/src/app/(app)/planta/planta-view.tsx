'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  MAX_ORDER_TABS,
  ProductionOrderKind,
  Role,
  type ProductionOrderListItemDto,
  type RoofingBatchOrderDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DrywallOrderPanel } from './drywall-order-panel';
import { DrywallOrderCard, RoofingQueueCard } from './new-order-cards';
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
 * Ahora es una sola pantalla con un **filtro**: todas las órdenes abiertas, o las de un pedido
 * (`?pedido=`). Adentro, cada orden es una pestaña con su ciclo completo, y la clase de la
 * orden decide qué panel se dibuja —coberturas o perfiles—, que es la única diferencia real
 * entre las dos ramas (D-087).
 *
 * El detalle de una orden (`/produccion/:id`) queda de **solo lectura**: costos, kardex y
 * correcciones. Producir es acá, y en un solo lugar.
 */

/** §3.4: producción es de ADMINISTRADOR y SUPERVISOR_PLANTA. */
const PLANT_ROLES = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Solo coberturas: el DTO completo que su panel necesita. */
  roofing: RoofingBatchOrderDto | null;
}

export function PlantaView() {
  const params = useSearchParams();
  const salesOrderId = params.get('pedido');
  const focused = params.get('op');
  const [activeId, setActiveId] = useState<string | null>(
    focused && UUID.test(focused) ? focused : null,
  );
  /** D-124: día de negocio de todo lo que se reporte en esta sesión. Solo lo ve un admin. */
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  /**
   * Los borradores y los avisos viven acá y no en la pestaña **a propósito**: con estado
   * local, saltar a otra orden para verificar de qué bobina salió algo y volver borraba lo
   * transcripto sin ningún aviso.
   */
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>({});
  const [saved, setSaved] = useState<Record<string, SavedNotes>>({});

  const roofing = useQuery({
    queryKey: ['roofing-batch', salesOrderId],
    queryFn: () =>
      api<RoofingBatchOrderDto[]>(
        `/production/roofing/batch${salesOrderId === null ? '' : `?salesOrderId=${salesOrderId}`}`,
      ),
  });
  // Las dos consultas de siempre de la terminal: el API filtra por estado, porque traer las
  // 500 más recientes para quedarse con tres es caro en una tablet.
  const draftOrders = useQuery({
    queryKey: ['production-orders', 'planta', 'DRAFT'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=DRAFT'),
  });
  const inProgress = useQuery({
    queryKey: ['production-orders', 'planta', 'IN_PROGRESS'],
    queryFn: () => api<ProductionOrderListItemDto[]>('/production?status=IN_PROGRESS'),
  });

  const rows = useMemo<WorkspaceOrder[]>(() => {
    const roofingRows = (roofing.data ?? []).map(toRoofingRow);
    const drywallRows = [...(inProgress.data ?? []), ...(draftOrders.data ?? [])]
      .filter((o) => o.kind === ProductionOrderKind.DRYWALL)
      // Con el filtro por pedido, una corrida de stock de otro producto no tiene nada que
      // hacer en la lista: lo que se está produciendo es **ese** pedido.
      .filter((o) => salesOrderId === null || o.salesOrderId === salesOrderId)
      .map(toDrywallRow);
    return [...roofingRows, ...drywallRows];
  }, [roofing.data, inProgress.data, draftOrders.data, salesOrderId]);

  const pending = roofing.isPending || draftOrders.isPending || inProgress.isPending;
  const failed = roofing.isError || draftOrders.isError || inProgress.isError;
  /**
   * Alguna de las tres listas está viajando. Es distinto de `pending`, que solo es cierto la
   * primera vez: acá también cuenta el refetch que dispara crear, montar, reportar o cerrar.
   */
  const refreshing =
    pending || roofing.isFetching || draftOrders.isFetching || inProgress.isFetching;

  /**
   * `?op=` **se re-lee cuando cambia**, no solo al montar: con dos enlaces «Producir esta
   * orden» en la app, navegar de `?op=A` a `?op=B` no desmonta esta ruta y la pantalla se
   * quedaba en la orden anterior. Es el mismo efecto que tenía la terminal antes de D-160.
   */
  useEffect(() => {
    if (focused !== null && UUID.test(focused)) setActiveId(focused);
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

  const active = rows.find((r) => r.orderId === activeId) ?? null;
  const roofingRows = rows.filter((r) => r.roofing !== null);
  const done = roofingRows.filter(
    (r) => r.roofing !== null && stateOf(r.roofing) === 'reportada',
  ).length;
  const asList = rows.length > MAX_ORDER_TABS;
  // Solo con un pedido acotado: sin `?pedido=` la lista mezcla clientes, y colgar el de la
  // primera orden del subtítulo lo haría pasar por el de todas.
  const customerName = salesOrderId === null ? null : (rows[0]?.customerName ?? null);
  const salesOrderCode = salesOrderId === null ? null : (rows[0]?.salesOrderCode ?? null);

  return (
    <RoleGate allow={PLANT_ROLES}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">
              {salesOrderId === null ? 'Producción' : `Producir ${salesOrderCode ?? 'el pedido'}`}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {salesOrderId === null
                ? 'Todas las órdenes abiertas. Cada una monta su material, reporta lo suyo y se cierra por separado.'
                : 'Una pestaña por orden del pedido. Monta la bobina y reporta sin salir de acá; cada orden se guarda por su cuenta.'}
              {customerName !== null && <> · {customerName}</>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {salesOrderId !== null && (
              <Button variant="outline" className="h-12" asChild>
                <Link href="/planta">Todas las órdenes abiertas</Link>
              </Button>
            )}
            <Button
              variant="outline"
              className="h-12"
              aria-expanded={creating}
              onClick={() => {
                setCreating((v) => !v);
              }}
            >
              {creating ? 'Ocultar' : 'Abrir una orden nueva'}
            </Button>
            <Button variant="outline" className="h-12" asChild>
              <Link href="/produccion">Órdenes de producción</Link>
            </Button>
          </div>
        </div>

        {/*
          D-160: crear la orden dejó de ser el paso 1 de la pantalla y pasó a ser una sección
          que se abre cuando hace falta. Lo que se hace todos los días es producir lo que ya
          está abierto; abrir una orden nueva es lo excepcional, y ocupaba la mitad de arriba.
        */}
        {/*
          D-171: la tarjeta «Nueva orden de coberturas a stock» se fue con la puerta que cerró
          en el API. Dejarla habría sido el callejón que D-156 prohíbe: el operario elige la
          plancha, tipea cuántas producir, aprieta y siempre recibe un 400. Una cobertura
          —plancha incluida— nace ahora del pedido que reserva su material, que es la tarjeta
          de la cola.
        */}
        {creating && (
          <div className="grid gap-4">
            <RoofingQueueCard onCreated={setActiveId} />
            <DrywallOrderCard onCreated={setActiveId} />
          </div>
        )}

        {pending && <Skeleton className="h-64 w-full" />}
        {failed && (
          <Alert variant="destructive">
            <AlertDescription>No se pudieron cargar las órdenes abiertas.</AlertDescription>
          </Alert>
        )}
        {!pending && !failed && rows.length === 0 && (
          <Alert>
            <AlertDescription>
              {salesOrderId === null
                ? 'No hay ninguna orden abierta. Abre una con el botón de arriba.'
                : 'Este pedido no tiene órdenes abiertas. Genéralas desde el detalle del pedido.'}
            </AlertDescription>
          </Alert>
        )}

        {rows.length > 0 && (
          <>
            {roofingRows.length > 0 && <Progress done={done} total={roofingRows.length} />}
            <div
              className={
                asList
                  ? 'grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr] lg:items-start'
                  : 'grid gap-4'
              }
            >
              <OrderPicker rows={rows} activeId={activeId} asList={asList} onSelect={setActiveId} />
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
    </RoleGate>
  );
}

function toRoofingRow(order: RoofingBatchOrderDto): WorkspaceOrder {
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
    roofing: order,
  };
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
          </button>
        );
      })}
    </div>
  );
}
