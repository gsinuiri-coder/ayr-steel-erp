'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  money,
  piecesMeters,
  salePriceFromValue,
  saleValueFromPrice,
  toFixedString,
  type CustomerDto,
  type SalesItemDto,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { isPositiveDecimal, unitSymbol } from '@/lib/format';
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
 * D-187: nuevo precio de una línea de un pedido confirmado. Solo ADMINISTRADOR. Se tipea el
 * precio **con IGV** —por metro en una plancha negociada así (D-161)—, igual que en la
 * cotización; el API vuelve a aplicar el piso (D-163) y registra el cambio.
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
  const [error, setError] = useState<string | null>(null);
  // El título muestra esto, no `item` directo: al cerrar, `item` pasa a `null` antes de que
  // termine la animación de cierre del diálogo, y el título parpadeaba a «Cambiar precio · L»
  // sin línea ni SKU durante ese instante.
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);
  const perMeter = item?.valuePerMeterPen !== null && item?.valuePerMeterPen !== undefined;

  useEffect(() => {
    if (item) {
      setLastItem(item);
      setPrice(typedPriceOf(item));
      setError(null);
    }
  }, [item]);

  const save = useMutation({
    mutationFn: (body: { unitPricePen: string } | { valuePerMeterPen: string }) =>
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
    if (!isPositiveDecimal(price)) {
      setError('Escribe un precio mayor a cero');
      return;
    }
    const value = toFixedString(money(saleValueFromPrice(price)), 'MONEY');
    save.mutate(perMeter ? { valuePerMeterPen: value } : { unitPricePen: value });
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
          <Label htmlFor="line-price">
            Precio con IGV {perMeter ? 'por metro' : `por ${unitSymbol(item?.unit ?? '')}`}
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
  // El título muestra esto, no `item` directo: ver el mismo comentario en
  // `EditLinePriceDialog`.
  const [lastItem, setLastItem] = useState<SalesItemDto | null>(null);
  // Regla dura 14: los largos los decide la unidad, no que la línea los haya traído.
  const byPieces = item?.unit === 'MTR';

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
              <Label htmlFor="line-qty">Cantidad ({unitSymbol(item?.unit ?? '')})</Label>
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

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => fetchAllForPicker<CustomerDto>('/customers'),
    enabled: open,
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
              options={(customers.data ?? [])
                .filter((c) => c.isActive && c.id !== order.customerId)
                .map((c) => ({ id: c.id, label: `${c.name} — ${c.docNumber}` }))}
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
