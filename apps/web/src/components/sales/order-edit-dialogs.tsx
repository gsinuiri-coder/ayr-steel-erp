'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BusinessLine,
  COIL_SKU_PREFIX,
  lineAmounts,
  money,
  piecesMeters,
  salePriceFromValue,
  saleValueFromPrice,
  toFixedString,
  type CoilPoolDto,
  type CustomerDto,
  type LineAmountBasis,
  type SalesItemDto,
  type SalesOrderDto,
  type UpdateSalesOrderItemPriceInput,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { customerLabel, formatMoney, formatQty, isPositiveDecimal, unitSymbol } from '@/lib/format';
import { EMPTY_PIECE_ROW, mmToMeters, parsePieceRows, type PieceRow } from '@/lib/pieces';
import { invalidateProduction } from '@/lib/production-queries';
import { invalidateSales } from '@/lib/sales-queries';
import { SearchSelectField } from '@/components/search-select-modal';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'La operación no se pudo completar';
}

/** Precio con IGV que se tipea, desde el valor guardado (D-162), y por metro si aplica (D-161). */
function typedPriceOf(item: SalesItemDto): string {
  const price = toFixedString(
    money(salePriceFromValue(item.valuePerMeterPen ?? item.unitPricePen)),
    'MONEY',
  );
  // El precio se negocia con dos decimales: `9.4400` se muestra `9.44`. Si de verdad trae
  // más —un valor importado—, se deja entero para que guardar sin tocar no lo mueva.
  return price.endsWith('00') ? price.slice(0, -2) : price;
}

/**
 * D-254: ¿la línea vende una bobina, o está enganchada al producto de venta de una? La que ya
 * reserva una bobina concreta (D-134), o la de un producto `BOB…` de la línea de reventa —la
 * misma marca que usa el API (`isCoilSaleProduct`)— que quedó sin bobina (COT-000002).
 */
export function isCoilSaleLine(item: SalesItemDto): boolean {
  return (
    item.reserveItemType === 'COIL' ||
    (item.businessLine === BusinessLine.TRADING &&
      item.productSku.toUpperCase().startsWith(COIL_SKU_PREFIX))
  );
}

/** D-255: cómo se carga el precio nuevo. La plancha por metro no cambia (D-161). */
type PriceMode = 'PRICE' | 'AMOUNT';

/**
 * D-187: nuevo precio de una línea de un pedido confirmado. Solo ADMINISTRADOR. Se tipea el
 * precio **con IGV** —por metro en una plancha negociada así (D-161)—, igual que en la
 * cotización; el API vuelve a aplicar el piso (D-163) y registra el cambio.
 *
 * D-255 (R2): o el **importe de la línea sin IGV**, y el unitario se deriva. El precio con IGV
 * viaja tal cual (`unitPriceWithIgvPen`): dividirlo acá entre 1.18 a cuatro decimales perdía
 * céntimos en las líneas grandes. Lo importado no pasa por el piso (D-256).
 */
export function EditLinePriceDialog({
  order,
  item,
  onOpenChange,
}: {
  order: SalesOrderDto;
  item: SalesItemDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PriceMode>('PRICE');
  const [error, setError] = useState<string | null>(null);
  // Todo lo que se **muestra** sale de esto, no de `item` directo: al cerrar, `item` pasa a
  // `null` antes de que termine la animación de cierre del diálogo, y leerlo ahí hacía
  // parpadear el título («Cambiar precio · L» sin línea ni SKU) y la unidad del precio
  // («por metro» ↔ «por NIU») durante ese instante.
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);
  const perMeter = lastItem?.valuePerMeterPen !== null && lastItem?.valuePerMeterPen !== undefined;

  useEffect(() => {
    if (item) {
      setLastItem(item);
      setPrice(typedPriceOf(item));
      setAmount(item.subtotalPen);
      setMode('PRICE');
      setError(null);
    }
  }, [item]);

  /**
   * D-255: lo que viaja y los importes que va a guardar el API, con la misma `lineAmounts`.
   * `null` mientras lo tipeado no es un número válido.
   */
  const next = ((): {
    body: UpdateSalesOrderItemPriceInput;
    basis: LineAmountBasis | null;
  } | null => {
    if (mode === 'AMOUNT') {
      if (!isPositiveDecimal(amount)) return null;
      const netAmountPen = toFixedString(amount.trim(), 'MONEY');
      return { body: { netAmountPen }, basis: { netAmountPen } };
    }
    if (!isPositiveDecimal(price)) return null;
    if (perMeter) {
      // D-161: la plancha sigue viajando por su valor por metro; el API multiplica por el largo.
      const valuePerMeterPen = toFixedString(money(saleValueFromPrice(price.trim())), 'MONEY');
      return { body: { valuePerMeterPen }, basis: null };
    }
    const unitPriceWithIgvPen = toFixedString(price.trim(), 'MONEY');
    return { body: { unitPriceWithIgvPen }, basis: { unitPriceWithIgvPen } };
  })();
  const preview = next?.basis && lastItem ? lineAmounts(lastItem.qty, next.basis) : null;

  const save = useMutation({
    mutationFn: (body: UpdateSalesOrderItemPriceInput) =>
      api<SalesOrderDto>(`/sales/orders/${order.id}/items/${item?.id ?? ''}/price`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      toast.success('Precio actualizado');
      invalidateSales(queryClient, { orderId: order.id });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorText(err));
    },
  });

  function submit(): void {
    if (save.isPending || !item) return;
    if (next === null) {
      setError(
        mode === 'AMOUNT' ? 'Escribe un importe mayor a cero' : 'Escribe un precio mayor a cero',
      );
      return;
    }
    save.mutate(next.body);
  }

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Cambiar precio · L{lastItem?.lineNumber} {lastItem?.productSku}
          </DialogTitle>
          <DialogDescription>
            Queda en el registro de cambios de precio del pedido, con tu nombre. El precio no puede
            bajar del mínimo de la línea de negocio.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {/* D-255: la forma de cargar el precio. La plancha por metro no la ofrece (D-161). */}
          {!perMeter && (
            <div className="flex gap-1" role="group" aria-label="Forma de cargar el precio">
              {(
                [
                  ['PRICE', 'Precio con IGV'],
                  ['AMOUNT', 'Importe de la línea'],
                ] as const
              ).map(([value, text]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={mode === value ? 'secondary' : 'ghost'}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                >
                  {text}
                </Button>
              ))}
            </div>
          )}
          {mode === 'AMOUNT' && !perMeter ? (
            <>
              <Label htmlFor="line-amount">Importe de la línea sin IGV</Label>
              <Input
                id="line-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
              />
            </>
          ) : (
            <>
              <Label htmlFor="line-price">
                Precio con IGV {perMeter ? 'por metro' : `por ${unitSymbol(lastItem?.unit ?? '')}`}
              </Label>
              <Input
                id="line-price"
                inputMode="decimal"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setError(null);
                }}
              />
            </>
          )}
          {/* D-255: lo que el API va a guardar, con la misma cuenta. */}
          {preview && lastItem && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatQty(lastItem.qty, unitSymbol(lastItem.unit))} · valor de venta{' '}
              {formatMoney(preview.subtotal.toFixed(4))} · IGV {formatMoney(preview.igv.toFixed(4))}{' '}
              · total {formatMoney(preview.total.toFixed(4))} · unitario{' '}
              {formatMoney(preview.unitValue.toFixed(10), 'PEN', 4)}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={save.isPending}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={submit}
          >
            Guardar precio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-187: nueva cantidad de una línea confirmada. Una línea a medida se edita por sus largos
 * (D-083) y la cantidad sale de la suma. El API la rechaza si la línea ya tiene reportes de
 * producción o despachos, y el mensaje dice que se agregue un ítem con la diferencia.
 */
export function EditLineQtyDialog({
  order,
  item,
  onOpenChange,
}: {
  order: SalesOrderDto;
  item: SalesItemDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [qty, setQty] = useState('');
  const [rows, setRows] = useState<PieceRow[]>([EMPTY_PIECE_ROW]);
  const [error, setError] = useState<string | null>(null);
  // Todo lo que se muestra sale de esto, no de `item` directo: ver el comentario en
  // `EditLinePriceDialog`. Acá importa más que en el de precio — sin esto, `byPieces` caía a
  // `false` al cerrar y el formulario cambiaba de "planchas por largo" a un campo de cantidad
  // simple (o al revés) en plena animación de salida.
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);
  // Regla dura 14: los largos los decide la unidad, no que la línea los haya traído.
  const byPieces = lastItem?.unit === 'MTR';

  useEffect(() => {
    if (item) {
      setLastItem(item);
      setQty(item.qty);
      setRows(
        item.pieces.length > 0
          ? item.pieces.map((p) => ({ lengthM: mmToMeters(p.lengthMm), qty: String(p.qty) }))
          : [EMPTY_PIECE_ROW],
      );
      setError(null);
    }
  }, [item]);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<SalesOrderDto>(`/sales/orders/${order.id}/items/${item?.id ?? ''}/qty`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      toast.success('Cantidad actualizada');
      invalidateSales(queryClient, { orderId: order.id });
      // El plan de corte de la OP cambió con la cantidad.
      invalidateProduction(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorText(err));
    },
  });

  function submit(): void {
    if (save.isPending || !item) return;
    if (byPieces) {
      const parsed = parsePieceRows(rows);
      if (!parsed.ok) {
        setError(parsed.reason);
        return;
      }
      save.mutate({
        qty: piecesMeters(parsed.pieces).toFixed(3),
        pieces: parsed.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
      });
      return;
    }
    if (!isPositiveDecimal(qty)) {
      setError('La cantidad debe ser mayor a cero');
      return;
    }
    save.mutate({ qty: toFixedString(qty, 'KG') });
  }

  function patchRow(i: number, patch: Partial<PieceRow>): void {
    setRows((current) => current.map((r, j) => (i === j ? { ...r, ...patch } : r)));
    setError(null);
  }

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Cambiar cantidad · L{lastItem?.lineNumber} {lastItem?.productSku}
          </DialogTitle>
          <DialogDescription>
            Ajusta la reserva de material y, si la línea se fabrica, el plan de corte de su orden.
            Solo mientras la orden no tenga reportes de producción y la línea no tenga despachos.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {byPieces ? (
            <>
              <span className="text-sm font-medium">Planchas (cantidad × largo en metros)</span>
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="w-24"
                    inputMode="numeric"
                    aria-label={`Planchas del largo ${String(i + 1)}`}
                    value={row.qty}
                    onChange={(e) => {
                      patchRow(i, { qty: e.target.value });
                    }}
                  />
                  <span className="text-muted-foreground">×</span>
                  <Input
                    className="w-28"
                    inputMode="decimal"
                    aria-label={`Largo ${String(i + 1)} en metros`}
                    value={row.lengthM}
                    onChange={(e) => {
                      patchRow(i, { lengthM: e.target.value });
                    }}
                  />
                  <span className="text-muted-foreground">m</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-9"
                    aria-label={`Quitar el largo ${String(i + 1)}`}
                    disabled={rows.length === 1}
                    onClick={() => {
                      setRows((current) => current.filter((_, j) => j !== i));
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  setRows((current) => [...current, EMPTY_PIECE_ROW]);
                }}
              >
                Agregar largo
              </Button>
            </>
          ) : (
            <>
              <Label htmlFor="line-qty">Cantidad ({unitSymbol(lastItem?.unit ?? '')})</Label>
              <Input
                id="line-qty"
                inputMode="decimal"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value);
                  setError(null);
                }}
              />
            </>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={save.isPending}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={submit}
          >
            Guardar cantidad
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-254 (R1): atar una línea de venta de bobina a otra bobina de su pool, con motivo. Sirve
 * también para la línea que quedó enganchada al producto `BOB…` sin bobina (COT-000002). Las
 * candidatas las calcula el API (espesor exacto, mismo color comercial o tipo, libres y con
 * saldo para la cantidad); la cantidad y el importe no cambian. Dueño o ADMINISTRADOR.
 */
export function ChangeLineCoilDialog({
  order,
  item,
  onOpenChange,
}: {
  order: SalesOrderDto;
  item: SalesItemDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [coilId, setCoilId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Todo lo que se muestra sale de esto, no de `item` directo: ver `EditLinePriceDialog`.
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);

  useEffect(() => {
    if (item) {
      setLastItem(item);
      setCoilId('');
      setReason('');
      setError(null);
    }
  }, [item]);

  const pool = useQuery({
    queryKey: ['coil-pool', lastItem?.productId, lastItem?.qty, order.id],
    queryFn: () =>
      api<CoilPoolDto>(
        `/sales/coil-pool?${new URLSearchParams({
          productId: lastItem?.productId ?? '',
          qty: lastItem?.qty ?? '',
          exceptSalesOrderId: order.id,
        }).toString()}`,
      ),
    enabled: item !== null && lastItem !== null,
  });
  const currentCoilId = lastItem?.reserveItemType === 'COIL' ? lastItem.reserveItemId : null;
  // La candidata que el API elegiría sola llega preseleccionada, salvo que ya sea la de la línea.
  const autoCoilId = pool.data?.autoCoilId !== currentCoilId ? (pool.data?.autoCoilId ?? '') : '';
  const chosen = coilId !== '' ? coilId : autoCoilId;

  const save = useMutation({
    mutationFn: (body: { saleCoilId: string; reason: string }) =>
      api<SalesOrderDto>(`/sales/orders/${order.id}/items/${item?.id ?? ''}/coil`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      toast.success('Bobina actualizada');
      invalidateSales(queryClient, { orderId: order.id });
      void queryClient.invalidateQueries({ queryKey: ['coil-pool'] });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorText(err));
    },
  });

  const trimmed = reason.trim();
  const ready = chosen !== '' && chosen !== currentCoilId && trimmed.length >= 3;

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Cambiar bobina · L{lastItem?.lineNumber} {lastItem?.productSku}
          </DialogTitle>
          <DialogDescription>
            {currentCoilId !== null
              ? `Hoy vende ${lastItem?.reserveItemLabel ?? 'una bobina'}. `
              : 'La línea todavía no tiene bobina. '}
            La cantidad ({formatQty(lastItem?.qty ?? '0', 'kg')}) y el importe no cambian.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="line-coil">Bobina del pool</Label>
            {pool.data !== undefined && pool.data.taken.length > 0 && (
              <p className="text-xs text-muted-foreground">
                No se ofrecen: {pool.data.taken.map((t) => `${t.code} (${t.by})`).join(', ')}
              </p>
            )}
            {pool.isPending ? (
              <p className="text-xs text-muted-foreground">Buscando bobinas del pool…</p>
            ) : pool.isError ? (
              <p className="text-xs text-destructive">{errorText(pool.error)}</p>
            ) : pool.data.candidates.length === 0 ? (
              <p className="text-xs text-destructive">
                Ninguna bobina libre del pool {pool.data.sku} alcanza para{' '}
                {formatQty(lastItem?.qty ?? '0', 'kg')} (disponible en el pool:{' '}
                {formatQty(pool.data.availableKg, 'kg')}).
              </p>
            ) : (
              <>
                <Select
                  value={chosen}
                  onValueChange={(v) => {
                    setCoilId(v);
                    setError(null);
                  }}
                >
                  <SelectTrigger id="line-coil" className="w-full" aria-label="Bobina del pool">
                    <SelectValue placeholder="Elige la bobina" />
                  </SelectTrigger>
                  <SelectContent>
                    {pool.data.candidates.map((c) => (
                      <SelectItem key={c.coilId} value={c.coilId}>
                        {c.code} · {c.widthMm} mm · {formatQty(c.balanceKg, 'kg')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {pool.data.sku}: {formatQty(pool.data.availableKg, 'kg')} disponibles en el pool.
                </p>
              </>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="line-coil-reason">Motivo</Label>
            <Input
              id="line-coil-reason"
              maxLength={240}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={!ready || save.isPending}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              if (!ready || save.isPending) return;
              save.mutate({ saleCoilId: chosen, reason: trimmed });
            }}
          >
            Cambiar bobina
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** D-187: cambiar el cliente (razón social) de un pedido sin comprobante. Solo ADMINISTRADOR. */
export function ChangeCustomerDialog({
  order,
  open,
  onOpenChange,
}: {
  order: SalesOrderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // RF-S3/M1: busca en el servidor; solo hidrata por id lo que el usuario acaba de elegir
  // (no hay valor previo que mostrar — se empieza en `null`, D-187).
  const selectedCustomer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api<CustomerDto>(`/customers/${customerId}`),
    enabled: customerId !== null,
  });

  useEffect(() => {
    if (open) {
      setCustomerId(null);
      setReason('');
      setError(null);
    }
  }, [open]);

  const save = useMutation({
    mutationFn: (body: { customerId: string; reason: string }) =>
      api<SalesOrderDto>(`/sales/orders/${order.id}/customer`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast.success('Cliente actualizado');
      invalidateSales(queryClient, { orderId: order.id });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorText(err));
    },
  });

  const trimmed = reason.trim();
  const ready = customerId !== null && customerId !== order.customerId && trimmed.length >= 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cambiar cliente de {order.code}</DialogTitle>
          <DialogDescription>
            Hoy: {order.customerName} ({order.customerDocNumber}). Se puede cambiar hasta que el
            pedido tenga comprobante.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="order-customer">Cliente nuevo</Label>
            <SearchSelectField
              id="order-customer"
              className="w-full"
              label="Cliente nuevo"
              placeholder="Elige un cliente"
              value={customerId}
              selectedOption={
                selectedCustomer.data
                  ? { id: selectedCustomer.data.id, label: customerLabel(selectedCustomer.data) }
                  : null
              }
              selectedOptionLoading={selectedCustomer.isLoading}
              search={(q) =>
                api<CustomerDto[]>(`/customers/search?q=${encodeURIComponent(q)}`).then((list) =>
                  list
                    .filter((c) => c.id !== order.customerId)
                    .map((c) => ({ id: c.id, label: customerLabel(c) })),
                )
              }
              onChange={(id) => {
                setCustomerId(id);
                setError(null);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="order-customer-reason">Motivo</Label>
            <Input
              id="order-customer-reason"
              maxLength={240}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={!ready || save.isPending}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              if (customerId === null || !ready || save.isPending) return;
              save.mutate({ customerId, reason: trimmed });
            }}
          >
            Cambiar cliente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
