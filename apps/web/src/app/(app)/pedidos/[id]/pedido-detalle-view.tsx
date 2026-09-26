'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  RESERVATION_STALE_DAYS,
  RESERVATION_STATUS_LABELS,
  Role,
  type ReservationDto,
  type RoofingBatchCreateResultDto,
  type SalesItemDto,
  toDecimal,
  type SalesOrderDto,
  type SalesOrderProgressDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatMoney, formatQty, formatTimestampDate, unitSymbol } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { invalidateSales } from '@/lib/sales-queries';
import { RESERVATION_TONE } from '@/components/status-tone';
import { InfoPopover } from '@/components/info-popover';
import { OperationDateField } from '@/components/operation-date-field';
import { PromisedDateControl } from '@/components/production-queue';
import { ProductionOrdersCard } from './production-orders-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AuditHistoryLink } from '@/components/audit-history-link';
import { HeaderActions } from '@/components/header-actions';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Stat, StatStrip } from '@/components/stat-strip';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import {
  ChangeCustomerDialog,
  ChangeLineCoilDialog,
  EditLinePriceDialog,
  EditLineQtyDialog,
  isCoilSaleLine,
} from '@/components/sales/order-edit-dialogs';
import { usePlantSheetActions } from '@/components/sales/plant-sheet-buttons';
import { PriceChangesCard } from '@/components/sales/price-changes-card';
import { OrderStageBadge } from '@/components/sales/status-badges';
import { customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';
import { RowActions } from '@/components/row-actions';

function reservationBadge(r: ReservationDto) {
  return <Badge variant={RESERVATION_TONE[r.status]}>{RESERVATION_STATUS_LABELS[r.status]}</Badge>;
}

/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** D-065/D-066: detalle del pedido, con la reserva visible y su liberación. */
export function PedidoDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [cancelOpen, setCancelOpen] = useState(false);
  const [releasing, setReleasing] = useState<ReservationDto | null>(null);
  // D-187: las ediciones del pedido confirmado, hasta su comprobante.
  const [pricing, setPricing] = useState<SalesItemDto | null>(null);
  const [resizing, setResizing] = useState<SalesItemDto | null>(null);
  /** D-254: la línea de venta de bobina que se reata a otra bobina de su pool. */
  const [recoiling, setRecoiling] = useState<SalesItemDto | null>(null);
  const [changingCustomer, setChangingCustomer] = useState(false);
  /** D-124/D-148: día con el que nacen las órdenes que genera el botón. Solo lo ve un admin. */
  const [ordersDate, setOrdersDate] = useState<string | undefined>(undefined);
  /** F8-S3b/M3: generar las órdenes pasa por un diálogo que ofrece esa fecha. */
  const [generateOpen, setGenerateOpen] = useState(false);

  const order = useQuery({
    queryKey: ['sales-order', id],
    queryFn: () => api<SalesOrderDto>(`/sales/orders/${id}`),
  });
  const o = order.data;
  // D-312: lo pendiente de despachar, con la misma consulta y la misma cifra que el formulario
  // de despacho (`pendingDispatchQty`). Comparte su clave: abrir el formulario no la repite.
  const progress = useQuery({
    queryKey: ['order-progress', id],
    queryFn: () => api<SalesOrderProgressDto>(`/invoicing/orders/${id}/progress`),
  });
  // Antes de los retornos tempranos: es un hook (el de compartir mira `navigator`).
  const plantSheetActions = usePlantSheetActions(id, o?.code ?? '');

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }

  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api<SalesOrderDto>(`/sales/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success('Pedido anulado y reservas liberadas');
      setCancelOpen(false);
      invalidateSales(queryClient, { orderId: id, quotationId: o?.quotationId ?? undefined });
    },
    onError,
  });

  const release = useMutation({
    mutationFn: ({ reservationId, reason }: { reservationId: string; reason: string }) =>
      api<ReservationDto>(`/sales/reservations/${reservationId}/release`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Reserva liberada');
      setReleasing(null);
      invalidateSales(queryClient, { orderId: id });
    },
    onError,
  });

  /**
   * D-148: generar la OP de cada línea a medida que todavía no la tiene. No es un modo
   * nuevo de crear órdenes —cada una nace de su reserva como siempre (D-084)—, solo evita
   * que un pedido de ocho líneas quede con cinco en cola y tres olvidadas.
   */
  const generateOrders = useMutation({
    mutationFn: () =>
      api<RoofingBatchCreateResultDto>(`/production/roofing/from-sales-order/${id}`, {
        method: 'POST',
        // D-124: la corrida se puede fechar como cualquier otro hecho del dominio, igual que
        // cuando la orden se crea de a una desde `/planta`. Sin esto, las OP de un pedido
        // importado con fecha vieja nacían fechadas hoy y nadie podía decir otra cosa.
        body: { operationDate: ordersDate },
      }),
    onSuccess: (result) => {
      toast.success(
        result.created.length === 1
          ? `Orden ${result.created[0]?.code ?? ''} creada`
          : `${String(result.created.length)} órdenes creadas: ${result.created.map((c) => c.code).join(', ')}`,
      );
      invalidateSales(queryClient, { orderId: id });
      invalidateProduction(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['production-queue'] });
    },
    onError,
  });

  if (order.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (order.isError || !o) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar el pedido.</AlertDescription>
      </Alert>
    );
  }

  // D-148: líneas a medida que reservan materia prima, siguen activas y todavía no tienen
  // OP. Es lo mismo que el API vuelve a resolver al crearlas: acá solo decide si el botón
  // tiene sentido y con qué número.
  const pendingRoofingLines = o.reservations.filter(
    (r) => r.status === 'ACTIVE' && r.itemType === 'RAW_MATERIAL' && r.productionOrderId === null,
  ).length;
  // D-155: líneas a medida que ya tienen su OP viva. Es lo que hace que "Producir" tenga
  // algo que abrir: sin una sola orden, el espacio de producción llega vacío.
  //
  // **`ACTIVE` también acá**, igual que arriba: una reserva `CONSUMED` conserva su
  // `productionOrderId`, así que un pedido ya producido y cerrado ofrecía "Producir (3)" y
  // llevaba a una pantalla que dice "este pedido no tiene órdenes abiertas" — el espacio de
  // producción solo trae las órdenes en borrador o en curso.
  const queuedRoofingLines = o.reservations.filter(
    (r) => r.status === 'ACTIVE' && r.itemType === 'RAW_MATERIAL' && r.productionOrderId !== null,
  ).length;
  // D-311: una reserva consumida la consumió una **entrega** (despacho) o una orden de
  // producción. Solo la segunda impide anular hasta revertir la orden; la primera ya es un
  // hecho consumado y el aviso dice dónde se entregó.
  const consumed = o.reservations.filter((r) => r.status === 'CONSUMED' && r.dispatchId === null);
  const delivered = o.reservations.filter((r) => r.status === 'CONSUMED' && r.dispatchId !== null);
  const deliveryCodes = [
    ...new Map(delivered.map((r) => [r.dispatchId, r.dispatchCode] as const)).entries(),
  ];
  const stale = o.reservations.filter((r) => r.isStale);
  // El botón se apaga cuando una OP viva está fabricando con el material: el propio aviso
  // de abajo dice que no se puede, y dejarlo habilitado terminaba en un diálogo con motivo
  // escrito y un toast de error.
  const blockedByProduction = o.reservations.some(
    (r) => r.productionOrderId !== null && r.status === 'CONSUMED',
  );
  const canCancel = o.status !== 'CANCELLED' && o.status !== 'FULFILLED' && !blockedByProduction;
  // Un pedido anulado no se despacha ni se factura; uno ya atendido tampoco se despacha,
  // pero sí se puede seguir facturando, así que el botón de comprobante vive con este
  // mismo permiso y el API es el que corta lo que ya no queda pendiente.
  const canOperate = o.status !== 'CANCELLED';
  // D-312: «Despachar» solo si hay algo que despachar. Un pedido atendido o anulado, o cuyas
  // líneas ya salieron completas, no lo ofrece. Mientras la cifra no llega se asume que sí
  // (el caso normal), y el API sigue siendo quien corta lo que ya no queda.
  const hasPendingDispatch =
    progress.data === undefined ||
    progress.data.lines.some((l) => toDecimal(l.pendingDispatchQty).gt(0));
  const canDispatch = canOperate && o.status !== 'FULFILLED' && hasPendingDispatch;
  // F8-S1/M1: anular, liberar una reserva y generar las OP de golpe cambian el mismo
  // pedido; sin este `busy` combinado, "Anular pedido" seguía habilitado mientras
  // "Generar todas las órdenes" del mismo pedido estaba en vuelo.
  const busy = cancel.isPending || release.isPending || generateOrders.isPending;
  // D-187: precio y cliente son de ADMINISTRADOR; agregar ítems y cambiar cantidades, también
  // del vendedor dueño del pedido. El API es el que corta; esto solo evita ofrecer un 403.
  const canEditAsAdmin = o.isEditable && isAdmin;
  const canEditAsOwner = o.isEditable && (isAdmin || user.id === o.sellerId);
  const showLineActions = canEditAsAdmin || canEditAsOwner;

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">{o.code}</h1>
            <OrderStageBadge stage={o.stage} />
            {/* RF-37 (D-093): "en cola" no es un estado del pedido, es una vista derivada. */}
            {o.queueStatus === 'EN_COLA' && <Badge variant="outline">En cola de producción</Badge>}
            {o.queueStatus === 'EN_PRODUCCION' && <Badge variant="progress">En producción</Badge>}
            {/*
              D-141: un pedido importado se comporta como cualquier otro, pero no nació acá,
              y eso cambia lo que se puede esperar de él — el que está atendido nunca tuvo
              despacho ni movió kardex. Se marca por el mismo motivo por el que se marca un
              comprobante importado (D-105).
            */}
            {o.origin === 'IMPORTED' && <Badge variant="outline">Importado</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={customerSearchHref(o.customerDocNumber)} className={LINK_CLASSNAME}>
              {o.customerName}
            </Link>{' '}
            · {o.customerDocNumber} · {/* D-119: un pedido puede mezclar líneas de negocio. */}
            {o.businessLines.map((b) => BUSINESS_LINE_LABELS[b]).join(', ')}
            {o.quotationId && (
              <>
                {' · '}
                <Link href={`/cotizaciones/${o.quotationId}`} className={LINK_CLASSNAME}>
                  {o.quotationCode}
                </Link>
              </>
            )}
            {/* D-141: la otra punta del enlace bidireccional documento↔pedido. */}
            {o.importedDocumentId && (
              <>
                {' · '}
                <Link href={`/comprobantes/${o.importedDocumentId}`} className={LINK_CLASSNAME}>
                  {o.importedDocumentNumber ?? 'comprobante importado'}
                </Link>
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            Fecha prometida:{' '}
            {o.promisedDeliveryDate ? formatDate(o.promisedDeliveryDate) : 'sin fecha'}
          </p>
          {isAdmin && o.status !== 'CANCELLED' && (
            <div className="mt-2">
              <PromisedDateControl
                salesOrderId={o.id}
                salesOrderCode={o.code}
                promisedDeliveryDate={o.promisedDeliveryDate}
              />
            </div>
          )}
        </div>
        {/*
          F8-S3b/M3: principal + «⋯». Principal: despachar, que es lo que sigue al pedido y lo
          cierra (D-074); con el pedido anulado no hay principal. Facturar corre por separado y
          no cierra el pedido, así que va al menú con el resto.
        */}
        <div className="flex items-center gap-2">
          <AuditHistoryLink entityType="sales_orders" entityId={o.id} />
          <HeaderActions
            primary={['dispatch']}
            actions={[
              {
                key: 'dispatch',
                label: 'Despachar',
                show: canDispatch,
                href: `/despachos/nuevo?pedido=${o.id}`,
              },
              {
                key: 'invoice',
                label: 'Emitir comprobante',
                show: canOperate,
                href: `/comprobantes/nuevo?pedido=${o.id}`,
              },
              // D-149: el papel que baja al taller, sin importes.
              ...plantSheetActions.map((a) => ({ ...a, show: canOperate && a.show !== false })),
              // D-160: el espacio de producción, acotado a este pedido.
              {
                key: 'produce',
                label: `Producir (${String(queuedRoofingLines)})`,
                show: isAdmin && canOperate && queuedRoofingLines > 0,
                href: `/planta?pedido=${o.id}`,
              },
              // D-148: una OP por cada línea a medida que todavía no la tiene, de una vez. Solo
              // ADMINISTRADOR: VENDEDOR —que sí ve este pedido— no llega al endpoint (§3.4).
              {
                key: 'generate',
                label: `Generar todas las órdenes (${String(pendingRoofingLines)})`,
                show: isAdmin && canOperate && pendingRoofingLines > 0,
                disabled: busy,
                pending: generateOrders.isPending,
                pendingText: 'Generando…',
                onSelect: () => {
                  if (busy) return;
                  setGenerateOpen(true);
                },
              },
              {
                key: 'add-items',
                label: 'Agregar ítems',
                show: canEditAsOwner,
                href: `/pedidos/${o.id}/agregar`,
              },
              {
                key: 'change-customer',
                label: 'Cambiar cliente',
                show: canEditAsAdmin,
                disabled: busy,
                onSelect: () => {
                  setChangingCustomer(true);
                },
              },
              {
                key: 'cancel',
                label: 'Anular pedido',
                show: isAdmin && canCancel,
                destructive: true,
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setCancelOpen(true);
                },
              },
            ]}
          />
        </div>
        {/*
          La fecha de las órdenes (D-124) vivía debajo del botón; dentro de un menú no tiene
          dónde ir, así que generar pasa por un diálogo corto que la ofrece antes de crear nada.
        */}
        <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Generar las órdenes de {o.code}</DialogTitle>
              <DialogDescription>
                Crea la orden de producción de cada línea a medida que todavía no la tiene (
                {pendingRoofingLines}), con el plan de corte del pedido.
              </DialogDescription>
            </DialogHeader>
            <OperationDateField value={ordersDate} onChange={setOrdersDate} />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setGenerateOpen(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                disabled={busy}
                pending={generateOrders.isPending}
                pendingText="Generando…"
                onClick={() => {
                  if (busy) return;
                  generateOrders.mutate(undefined, {
                    onSuccess: () => {
                      setGenerateOpen(false);
                    },
                  });
                }}
              >
                Generar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {consumed.length > 0 && o.status !== 'CANCELLED' && (
        <Alert>
          <AlertDescription>
            {consumed.length === 1
              ? 'Una reserva ya fue consumida'
              : `${consumed.length} reservas ya fueron consumidas`}{' '}
            por producción: el pedido no se puede anular hasta revertir o anular esa orden.
          </AlertDescription>
        </Alert>
      )}
      {delivered.length > 0 && (
        <Alert>
          <AlertDescription>
            Entregada en{' '}
            {deliveryCodes.map(([id, code], index) => (
              <span key={id}>
                {index > 0 && ', '}
                <Link href={`/despachos/${id ?? ''}`} className={LINK_CLASSNAME}>
                  {code}
                </Link>
              </span>
            ))}
            .
          </AlertDescription>
        </Alert>
      )}
      {stale.length > 0 && (
        <Alert>
          <AlertDescription>
            {stale.length === 1 ? 'Una reserva lleva' : `${stale.length} reservas llevan`} más de{' '}
            {RESERVATION_STALE_DAYS} días activa sin consumirse. Si el pedido ya no va, conviene
            liberarla para devolver el material al disponible.
          </AlertDescription>
        </Alert>
      )}

      <StatStrip>
        <Stat label="Fecha">{formatDate(o.issueDate)}</Stat>
        <Stat label="Subtotal">{formatMoney(o.subtotalPen)}</Stat>
        <Stat label="IGV">{formatMoney(o.igvPen)}</Stat>
        <Stat label="Total" className="font-semibold">
          {formatMoney(o.totalPen)}
        </Stat>
      </StatStrip>

      <Section title="Líneas">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              {/* D-162: valor = sin IGV. Es lo que la línea congeló al confirmarse. */}
              <TableHead className="text-right">Valor unitario</TableHead>
              <TableHead className="text-right">Valor de venta</TableHead>
              {showLineActions && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {o.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.lineNumber}</TableCell>
                <TableCell>
                  <div className="font-medium">{item.productSku}</div>
                  {item.reserveItemType === 'COIL' && (
                    <div className="text-xs text-muted-foreground">
                      Bobina {item.reserveItemLabel}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">{item.description}</div>
                </TableCell>
                <TableCell className="text-right">
                  {formatQty(item.qty, unitSymbol(item.unit))}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoney(item.unitPricePen, 'PEN', 4)}
                  {/* D-161: el valor por metro con el que se cotizó la plancha. */}
                  {item.valuePerMeterPen !== null && (
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatMoney(item.valuePerMeterPen, 'PEN', 4)} /m
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">{formatMoney(item.subtotalPen)}</TableCell>
                {showLineActions && (
                  <TableCell className="text-right">
                    <RowActions
                      label={`línea ${String(item.lineNumber)}`}
                      primary="price"
                      actions={[
                        {
                          key: 'price',
                          label: 'Precio',
                          ariaLabel: `Cambiar precio de la línea ${String(item.lineNumber)}`,
                          show: canEditAsAdmin,
                          onSelect: () => {
                            setPricing(item);
                          },
                        },
                        // D-116: una bobina entera vende su saldo; su cantidad no se edita.
                        {
                          key: 'qty',
                          label: 'Cantidad',
                          ariaLabel: `Cambiar cantidad de la línea ${String(item.lineNumber)}`,
                          show: canEditAsOwner && item.reserveItemType !== 'COIL',
                          onSelect: () => {
                            setResizing(item);
                          },
                        },
                        // D-254: atar la línea a una bobina de su pool; cantidad e importe quedan.
                        {
                          key: 'coil',
                          label: 'Bobina',
                          ariaLabel: `Cambiar bobina de la línea ${String(item.lineNumber)}`,
                          show: canEditAsOwner && isCoilSaleLine(item),
                          onSelect: () => {
                            setRecoiling(item);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {isAdmin && <ProductionOrdersCard salesOrderId={o.id} canOperate={canOperate} />}

      <Section
        title={
          <>
            Reservas de material
            <InfoPopover label="Sobre las reservas de material">
              Una reserva activa descuenta el disponible del ítem sin tocar el kardex (D-054): el
              material sigue físicamente en el almacén, pero ninguna otra operación lo puede tomar.
            </InfoPopover>
          </>
        }
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Ítem</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Orden o entrega</TableHead>
              <TableHead>Creada</TableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {o.reservations.map((r) => (
              <TableRow key={r.id} className={r.status === 'RELEASED' ? 'opacity-60' : undefined}>
                <TableCell>
                  <div className="font-medium">{r.itemLabel}</div>
                  <div className="text-xs text-muted-foreground">{r.itemName}</div>
                </TableCell>
                <TableCell className="text-right">{formatQty(r.qty, unitSymbol(r.unit))}</TableCell>
                <TableCell>
                  {reservationBadge(r)}
                  {r.isStale && (
                    <Badge variant="outline" className="ml-2">
                      Vieja
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {r.productionOrderId ? (
                    <Link href={`/produccion/${r.productionOrderId}`} className={LINK_CLASSNAME}>
                      {r.productionOrderCode}
                    </Link>
                  ) : r.dispatchId ? (
                    <Link href={`/despachos/${r.dispatchId}`} className={LINK_CLASSNAME}>
                      Entregada en {r.dispatchCode}
                    </Link>
                  ) : r.status === 'CONSUMED' ? (
                    <span className="text-muted-foreground">Consumida</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{formatTimestampDate(r.createdAt)}</TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    {r.status === 'ACTIVE' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          setReleasing(r);
                        }}
                      >
                        Liberar
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
            {o.reservations.length === 0 && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 6 : 5} className="text-center text-muted-foreground">
                  El pedido no tiene reservas.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>

      <PriceChangesCard changes={o.priceChanges} />

      {o.notes && (
        <Section title="Observaciones" bodyClassName="px-2.5 text-sm text-muted-foreground">
          {o.notes}
        </Section>
      )}

      <div className="text-xs text-muted-foreground">
        Creado por {o.createdByName ?? '—'} el {formatTimestampDate(o.createdAt)}.
      </div>

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Anular ${o.code}`}
        description="Libera las reservas activas y devuelve el material al disponible. Si el pedido vino de una cotización vigente, esa cotización vuelve a estar emitida."
        confirmLabel="Anular pedido"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          cancel.mutate(reason);
        }}
      />

      <ReasonDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null);
        }}
        title={`Liberar la reserva de ${releasing?.itemLabel ?? ''}`}
        description="El material vuelve al disponible y cualquier otra operación lo puede tomar. El pedido sigue vivo, pero deja de tener material comprometido."
        confirmLabel="Liberar reserva"
        pending={release.isPending}
        onConfirm={(reason) => {
          if (releasing) release.mutate({ reservationId: releasing.id, reason });
        }}
      />
      <EditLinePriceDialog
        order={o}
        item={pricing}
        onOpenChange={(open) => {
          if (!open) setPricing(null);
        }}
      />
      <EditLineQtyDialog
        order={o}
        item={resizing}
        onOpenChange={(open) => {
          if (!open) setResizing(null);
        }}
      />
      <ChangeLineCoilDialog
        order={o}
        item={recoiling}
        onOpenChange={(open) => {
          if (!open) setRecoiling(null);
        }}
      />
      <ChangeCustomerDialog order={o} open={changingCustomer} onOpenChange={setChangingCustomer} />
    </RoleGate>
  );
}
