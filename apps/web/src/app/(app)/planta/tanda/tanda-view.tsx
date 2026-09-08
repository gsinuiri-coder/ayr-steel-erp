'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  describePieces,
  MAX_BATCH_ROWS,
  piecesFromPlanMeters,
  piecesMeters,
  piecesTheoreticalKg,
  toDecimal,
  type RoofingBatchOrderDto,
  type RoofingBatchResultDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Reportar producción en tanda (D-147).
 *
 * El encargado no vuelve de la planta con una orden: vuelve con **una hoja** que tiene todo
 * lo que se produjo en el turno. Ir orden por orden por `/planta` obliga a buscar cada una,
 * abrirla y volver, y a mitad de la hoja ya nadie sabe qué transcribió. Acá la hoja entra
 * entera: una fila por orden, un número de metros por fila, y un solo botón.
 *
 * Dos reglas que la pantalla no puede aflojar y por eso muestra antes de dejar escribir:
 * el **tope del plan** (D-146) por fila, y que los metros salgan de un número entero de
 * planchas del plan — el desglose se calcula mientras se tipea, con la misma función que el
 * API usa para guardarlo (`piecesFromPlanMeters`), así que lo que la fila muestra es
 * exactamente lo que se va a grabar.
 *
 * El guardado es **todo o nada**: una transacción, y si una fila falla no se escribe
 * ninguna. Los errores vuelven todos juntos, fila por fila, porque quien transcribe una hoja
 * necesita corregirla de una vez y no descubrir un error por intento.
 */

interface RowDraft {
  meters: string;
  consumedKg: string;
  coilId: string;
}

const EMPTY_DRAFT: RowDraft = { meters: '', consumedKg: '', coilId: '' };

/** Lo que la fila resolvió con lo tipeado: el desglose en planchas, o el motivo del rechazo. */
interface RowState {
  order: RoofingBatchOrderDto;
  draft: RowDraft;
  touched: boolean;
  coil: RoofingBatchOrderDto['coils'][number] | undefined;
  planKg: Decimal | null;
  pieces: RoofingPieceDto[] | null;
  newKg: Decimal | null;
  error: string | null;
}

export function TandaView() {
  const params = useSearchParams();
  const salesOrderId = params.get('pedido');
  const queryClient = useQueryClient();

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const orders = useQuery({
    queryKey: ['roofing-batch', salesOrderId],
    queryFn: () =>
      api<RoofingBatchOrderDto[]>(
        `/production/roofing/batch${salesOrderId ? `?salesOrderId=${salesOrderId}` : ''}`,
      ),
  });

  const setDraft = (orderId: string, patch: Partial<RowDraft>) => {
    setDrafts((prev) => ({ ...prev, [orderId]: { ...EMPTY_DRAFT, ...prev[orderId], ...patch } }));
    // Tocar la fila borra el error que el servidor le puso: si no, el mensaje de la tanda
    // anterior sigue en pantalla mientras el operario ya la corrigió.
    setServerErrors((prev) => {
      if (prev[orderId] === undefined) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([id]) => id !== orderId));
    });
  };

  // **La tanda se arma sobre TODAS las órdenes, no sobre las visibles.** El filtro es una
  // ayuda para encontrar una fila en una lista larga; si la tanda se armara con lo filtrado,
  // escribir tres filas y después tipear en el filtro para buscar la cuarta dejaría las tres
  // primeras fuera del envío —y el `setDrafts({})` del éxito las borraría sin que nadie se
  // entere—, que es exactamente lo contrario de "la hoja entra entera".
  const rows: RowState[] = useMemo(
    () =>
      (orders.data ?? []).map((order) => resolveRow(order, drafts[order.orderId] ?? EMPTY_DRAFT)),
    [orders.data, drafts],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter((r) =>
      [
        r.order.code,
        r.order.productSku,
        r.order.productName,
        r.order.salesOrderCode,
        r.order.customerName,
      ]
        .filter((v): v is string => v !== null)
        .some((v) => v.toLowerCase().includes(needle)),
    );
  }, [rows, filter]);

  const filled = rows.filter((r) => r.draft.meters.trim() !== '');
  const blocking = filled.filter((r) => r.error !== null);
  const hidden = filled.length - visible.filter((r) => r.draft.meters.trim() !== '').length;
  const totalMeters = filled.reduce(
    (acc, r) => acc.plus(r.pieces === null ? new Decimal(0) : piecesMeters(r.pieces)),
    new Decimal(0),
  );

  const send = useMutation({
    mutationFn: (confirmBackdate: boolean) => {
      // Los errores por fila del intento anterior se van **antes** de reintentar: si el
      // segundo intento falla por otra vía (un 500, un 400 sin mapa), lo que quedaba en
      // pantalla eran mensajes viejos que ya no describen nada.
      setServerErrors({});
      return api<RoofingBatchResultDto>('/production/roofing/batch', {
        method: 'POST',
        body: {
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
          rows: filled.map((r) => ({
            orderId: r.order.orderId,
            meters: toDecimal(r.draft.meters.trim()).toFixed(3),
            ...(r.draft.coilId ? { coilId: r.draft.coilId } : {}),
            ...(r.draft.consumedKg.trim()
              ? { consumedKg: toDecimal(r.draft.consumedKg.trim()).toFixed(3) }
              : {}),
          })),
        },
      });
    },
    onSuccess: (result) => {
      toast.success(
        `Tanda registrada: ${String(result.orders)} órdenes · ${String(result.pieces)} planchas · ${result.meters} m`,
      );
      setDrafts({});
      setServerErrors({});
      invalidateProduction(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['roofing-batch'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors) {
        const mapped: Record<string, string> = {};
        for (const [orderId, messages] of Object.entries(err.errors)) {
          if (messages && messages.length > 0) mapped[orderId] = messages.join(' ');
        }
        setServerErrors(mapped);
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar la tanda');
    },
  });
  const backdate = useBackdateConfirm((confirmBackdate) => send.mutateAsync(confirmBackdate));

  const filteredByOrder = salesOrderId !== null ? (orders.data?.[0]?.salesOrderCode ?? null) : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reportar producción en tanda</h1>
          <p className="text-sm text-muted-foreground">
            Una fila por orden abierta de coberturas. Escribe los metros que salieron y, si lo
            tienes, los kilos que consumió la bobina. Se guarda todo junto o no se guarda nada.
          </p>
        </div>
        <Button variant="outline" className="h-12" asChild>
          <Link href="/planta">Terminal de planta</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Órdenes abiertas{' '}
            {orders.isSuccess && (
              <span className="text-sm font-normal text-muted-foreground">
                ({String(visible.length)} de {String(orders.data.length)})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="tanda-filtro">Filtrar por orden, producto, pedido o cliente</Label>
              <Input
                id="tanda-filtro"
                className="h-12"
                placeholder="OP-000123, PED-000045, Aceros…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                }}
              />
            </div>
            {salesOrderId !== null && (
              <Badge variant="outline" className="h-8 justify-self-start">
                Solo {filteredByOrder ?? 'un pedido'} ·{' '}
                <Link href="/planta/tanda" className="ml-1 underline">
                  ver todas
                </Link>
              </Badge>
            )}
          </div>

          {orders.isPending && <Skeleton className="h-40 w-full" />}
          {orders.isError && (
            <p className="text-sm text-destructive">No se pudieron cargar las órdenes abiertas.</p>
          )}
          {orders.isSuccess && visible.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hay órdenes de coberturas abiertas que coincidan.
            </p>
          )}

          {visible.length > 0 && (
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Órdenes de la tanda"
            >
              <table className="w-full min-w-[62rem] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3 font-medium">Orden</th>
                    <th className="py-2 pr-3 font-medium">Ítem</th>
                    <th className="py-2 pr-3 text-right font-medium">ML plan</th>
                    <th className="py-2 pr-3 text-right font-medium">ML reportado</th>
                    <th className="py-2 pr-3 text-right font-medium">ML restante</th>
                    <th className="py-2 pr-3 font-medium">ML nuevo</th>
                    <th className="py-2 font-medium">kg consumido</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <BatchRow
                      key={row.order.orderId}
                      row={row}
                      serverError={serverErrors[row.order.orderId] ?? null}
                      disabled={send.isPending}
                      onChange={(patch) => {
                        setDraft(row.order.orderId, patch);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1 text-sm">
            <p className="text-muted-foreground">
              {filled.length === 0
                ? 'Todavía no hay ninguna fila con metros.'
                : `${String(filled.length)} de ${String(rows.length)} órdenes · ${totalMeters.toFixed(3)} m en la tanda.`}
            </p>
            {hidden > 0 && (
              <p className="text-muted-foreground">
                {hidden === 1
                  ? 'Una fila con metros está fuera del filtro y entra igual en la tanda.'
                  : `${String(hidden)} filas con metros están fuera del filtro y entran igual en la tanda.`}
              </p>
            )}
            {blocking.length > 0 && (
              <p className="text-destructive">
                {String(blocking.length)}{' '}
                {blocking.length === 1 ? 'fila tiene un error' : 'filas tienen errores'}: corrígelas
                antes de enviar.
              </p>
            )}
            {filled.length > MAX_BATCH_ROWS && (
              <p className="text-destructive">
                Como máximo {MAX_BATCH_ROWS} órdenes por tanda: envía la hoja en dos partes.
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Button
              className="h-16 text-lg"
              disabled={
                filled.length === 0 ||
                blocking.length > 0 ||
                filled.length > MAX_BATCH_ROWS ||
                send.isPending
              }
              onClick={() => {
                void backdate.attempt();
              }}
            >
              {send.isPending ? 'Registrando…' : 'Registrar la tanda'}
            </Button>
            <OperationDateField value={operationDate} onChange={setOperationDate} />
          </div>
        </CardContent>
      </Card>

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={send.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />
    </div>
  );
}

function BatchRow({
  row,
  serverError,
  disabled,
  onChange,
}: {
  row: RowState;
  serverError: string | null;
  disabled: boolean;
  onChange: (patch: Partial<RowDraft>) => void;
}) {
  const { order } = row;
  const noCoil = order.coils.length === 0;
  const error = serverError ?? row.error;

  return (
    <tr className="border-b align-top">
      <td className="py-3 pr-3">
        {/*
          En otra pestaña a propósito: navegar desmonta la pantalla y se pierden todos los
          borradores de la hoja sin ningún aviso, justo cuando el operario abre la orden para
          verificar algo a mitad de la transcripción.
        */}
        <Link
          href={`/planta?op=${order.orderId}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono font-medium underline"
        >
          {order.code}
        </Link>
        <div className="text-xs text-muted-foreground">
          {order.salesOrderCode ?? 'A stock'}
          {order.customerName && <> · {order.customerName}</>}
        </div>
        {order.status === 'DRAFT' && (
          <div className="text-xs text-muted-foreground">En cola, sin arrancar</div>
        )}
      </td>
      <td className="py-3 pr-3">
        <div className="font-medium">{order.productSku}</div>
        <div className="text-xs text-muted-foreground">
          {order.remainingPieces.length > 0
            ? `Faltan ${describePieces(order.remainingPieces)}`
            : 'El plan ya está cubierto'}
        </div>
        {noCoil && (
          <div className="text-xs text-destructive">
            Sin bobina montada: móntala desde la terminal antes de reportar.
          </div>
        )}
        {order.coils.length > 1 && (
          <select
            aria-label={`Bobina de ${order.code}`}
            className="mt-1 h-9 rounded-md border bg-background px-2 text-xs"
            value={row.draft.coilId}
            disabled={disabled}
            onChange={(e) => {
              onChange({ coilId: e.target.value });
            }}
          >
            <option value="">Elige la bobina</option>
            {order.coils.map((c) => (
              <option key={c.coilId} value={c.coilId}>
                {c.coilCode} — {c.remainingKg} kg
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="py-3 pr-3 text-right tabular-nums">{order.planMeters}</td>
      <td className="py-3 pr-3 text-right tabular-nums text-muted-foreground">
        {order.reportedMeters}
      </td>
      <td className="py-3 pr-3 text-right tabular-nums font-medium">{order.remainingMeters}</td>
      <td className="py-3 pr-3">
        <Input
          aria-label={`Metros nuevos de ${order.code}`}
          inputMode="decimal"
          className="h-11 w-28 text-right"
          placeholder="0.000"
          disabled={disabled || noCoil}
          value={row.draft.meters}
          onChange={(e) => {
            onChange({ meters: e.target.value });
          }}
        />
        {row.pieces !== null && (
          <p className="mt-1 w-40 text-xs text-muted-foreground">{describePieces(row.pieces)}</p>
        )}
        {error !== null && <p className="mt-1 w-56 text-xs text-destructive">{error}</p>}
      </td>
      <td className="py-3">
        <Input
          aria-label={`Kilos consumidos de ${order.code}`}
          inputMode="decimal"
          className="h-11 w-28 text-right"
          placeholder={row.newKg === null ? 'opcional' : row.newKg.toFixed(3)}
          disabled={disabled || noCoil}
          value={row.draft.consumedKg}
          onChange={(e) => {
            onChange({ consumedKg: e.target.value });
          }}
        />
        {row.planKg !== null && (
          <p className="mt-1 w-40 text-xs text-muted-foreground">
            Tope {formatQty(row.planKg.toFixed(3), 'kg')}
            {toDecimal(order.declaredKg).gt(0) && <> · van {formatQty(order.declaredKg, 'kg')}</>}
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * Todo lo que una fila necesita decidir, con las mismas funciones de `@ayr/shared` que el
 * API vuelve a correr al guardar. La fila no adivina nada: si acá el desglose no sale, en el
 * servidor tampoco, y al revés.
 */
function resolveRow(order: RoofingBatchOrderDto, draft: RowDraft): RowState {
  const coil =
    order.coils.length === 1 ? order.coils[0] : order.coils.find((c) => c.coilId === draft.coilId);
  const geometry =
    coil === undefined
      ? null
      : { widthMm: coil.widthMm, thicknessMm: coil.thicknessMm, densityFactor: coil.densityFactor };
  const planKg =
    geometry === null || order.planItems.length === 0
      ? null
      : piecesTheoreticalKg(geometry, order.planItems);

  const base: RowState = {
    order,
    draft,
    touched: draft.meters.trim() !== '',
    coil,
    planKg,
    pieces: null,
    newKg: null,
    error: null,
  };

  const meters = draft.meters.trim();
  if (meters === '') return base;
  if (order.coils.length === 0) {
    return { ...base, error: 'La orden no tiene ninguna bobina montada.' };
  }
  // Una orden sin plan de corte no se puede capturar por metros: los largos salen del plan,
  // y sin plan no hay de dónde sacarlos. El API responde exactamente esto; decir "quedan
  // 0.000 m del plan" mandaría a corregir un plan que no existe.
  if (order.planItems.length === 0) {
    return {
      ...base,
      error: 'La orden no tiene plan de corte: reporta sus largos desde la terminal de planta.',
    };
  }
  if (order.coils.length > 1 && draft.coilId === '') {
    return { ...base, error: 'Indica de qué bobina salieron.' };
  }
  if (!/^\d+(\.\d{1,3})?$/.test(meters) || toDecimal(meters).lte(0)) {
    return { ...base, error: 'Los metros van con hasta tres decimales y mayores a cero.' };
  }
  // D-146: el tope del plan se comprueba antes que el desglose, porque es el error que el
  // operario puede corregir sin entender nada de largos.
  if (toDecimal(meters).gt(toDecimal(order.remainingMeters))) {
    return {
      ...base,
      error: `Del plan quedan ${order.remainingMeters} m: ajusta el plan de corte si de verdad hay que producir más.`,
    };
  }

  const split = piecesFromPlanMeters(order.planItems, reportedOf(order), meters);
  if (!split.ok) return { ...base, error: split.reason };
  const pieces = split.pieces.map((p, i) => ({ lineNumber: i + 1, ...p }));
  const newKg = geometry === null ? null : piecesTheoreticalKg(geometry, pieces);

  // El material montado también corta acá y no solo en el servidor: el API lo comprueba
  // dentro de `reportInTx` (`allocateStripKg`), o sea después de una transacción que puede
  // tardar un minuto y que se lleva puesta la tanda entera por una fila que la pantalla ya
  // sabía imposible.
  if (coil !== undefined && newKg?.gt(toDecimal(coil.remainingKg)) === true) {
    return {
      ...base,
      pieces,
      newKg,
      error: `${coil.coilCode} tiene ${coil.remainingKg} kg montados y estos metros necesitan ${newKg.toFixed(3)} kg: monta más material.`,
    };
  }

  const kg = draft.consumedKg.trim();
  if (kg !== '') {
    if (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0)) {
      return { ...base, pieces, newKg, error: 'Los kilos van con hasta tres decimales.' };
    }
    if (planKg !== null && toDecimal(order.declaredKg).plus(toDecimal(kg)).gt(planKg)) {
      return {
        ...base,
        pieces,
        newKg,
        error: `El plan pesa ${planKg.toFixed(3)} kg teóricos y ya hay ${order.declaredKg} kg declarados.`,
      };
    }
  }

  return { ...base, pieces, newKg };
}

/**
 * Los largos ya reportados de la orden, reconstruidos desde lo que el plan **todavía debe**:
 * es lo que `piecesFromPlanMeters` necesita para no volver a ofrecer una plancha que ya
 * salió. El DTO trae los pendientes ya resueltos por el servidor, así que la resta se hace
 * una sola vez y del lado que tiene los datos.
 */
function reportedOf(order: RoofingBatchOrderDto): RoofingPieceDto[] {
  const pending = new Map(order.remainingPieces.map((p) => [p.lengthMm, p.qty]));
  return order.planItems.map((item, i) => ({
    lineNumber: i + 1,
    lengthMm: item.lengthMm,
    qty: Math.max(item.qty - (pending.get(item.lengthMm) ?? 0), 0),
  }));
}
