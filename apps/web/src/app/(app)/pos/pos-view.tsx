'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Decimal,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  PAYMENT_METHOD_LABELS,
  POS_PAYMENT_METHODS,
  Role,
  salesLineTotals,
  toDecimal,
  toFixedString,
  type CustomerDto,
  type PosContextDto,
  type PosPaymentMethod,
  type PosProductDto,
  type PosSaleListItemDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatQty, unitSymbol } from '@/lib/format';
import { invalidatePos } from '@/lib/pos-queries';
import { useDebounced } from '@/lib/use-debounced';
import { useSession } from '@/lib/session';
import { RoleGate } from '@/components/role-gate';
import { ContingencyNotice } from '@/components/pos/contingency-notice';
import { CustomerPicker } from '@/components/pos/customer-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';

const POS_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

interface CartLine {
  product: PosProductDto;
  qty: string;
  unitPricePen: string;
}

/**
 * Punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * Una sola pantalla, pensada para una tablet en el mostrador: buscar, tocar el producto,
 * elegir el medio de pago y cobrar. Entre el carrito armado y la venta cerrada hay **dos
 * toques** —el medio y «Cobrar»— porque el cliente por defecto es "público en general" y la
 * fecha la pone el API: cada campo que no se pide es un toque que no se da.
 *
 * Todo lo que la pantalla muestra sale del API: el disponible es el real (físico menos
 * reservado, D-066) y el total lo recalcula `salesLineTotals`, la misma función que usa el
 * API para guardarlo (D-068). Si divergieran, el mostrador cobraría una cifra y el
 * comprobante diría otra.
 */
export function PosView() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [method, setMethod] = useState<PosPaymentMethod | null>(null);
  const [reference, setReference] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [opening, setOpening] = useState('0.00');
  const [done, setDone] = useState<PosSaleListItemDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const context = useQuery({
    queryKey: ['pos-context'],
    queryFn: () => api<PosContextDto>('/pos/context'),
  });
  const session = context.data?.session ?? null;

  const products = useQuery({
    queryKey: ['pos-products', debouncedSearch],
    queryFn: () =>
      api<PosProductDto[]>(
        `/pos/products${debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : ''}`,
      ),
    enabled: session !== null,
  });

  // La línea de negocio del carrito: un pedido tiene una sola (D-104), así que en cuanto
  // hay un producto el buscador marca los que no caben en vez de dejar que el API lo diga
  // después de tres toques.
  const cartLine = cart[0]?.product.businessLine ?? null;

  const totals = useMemo(() => {
    return cart.reduce(
      (acc, line) => {
        const t = salesLineTotals({ qty: line.qty || '0', unitPricePen: line.unitPricePen || '0' });
        return {
          subtotal: acc.subtotal.plus(t.subtotal),
          igv: acc.igv.plus(t.igv),
          total: acc.total.plus(t.total),
        };
      },
      { subtotal: new Decimal(0), igv: new Decimal(0), total: new Decimal(0) },
    );
  }, [cart]);

  const overGenericCap =
    customer === null && totals.total.gt(toDecimal(GENERIC_CUSTOMER_MAX_TOTAL_PEN));

  const openSession = useMutation({
    mutationFn: () =>
      api('/pos/cash-sessions', { method: 'POST', body: { openingAmountPen: opening } }),
    onSuccess: () => {
      invalidatePos(queryClient);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'No se pudo abrir la caja');
    },
  });

  const sell = useMutation({
    mutationFn: () =>
      api<PosSaleListItemDto>('/pos/sales', {
        method: 'POST',
        body: {
          customerId: customer?.id,
          method,
          reference: reference.trim() || undefined,
          forceGenericCustomer: customer === null && overGenericCap,
          items: cart.map((l) => ({
            productId: l.product.productId,
            qty: l.qty,
            unitPricePen: l.unitPricePen,
          })),
        },
      }),
    onMutate: () => {
      setError(null);
    },
    onSuccess: (sale) => {
      setDone(sale);
      setCart([]);
      setCustomer(null);
      setMethod(null);
      setReference('');
      invalidatePos(queryClient, {
        cashSessionId: sale.cashSessionId,
        orderId: sale.salesOrderId,
        documentId: sale.fiscalDocumentId,
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'No se pudo cerrar la venta');
    },
  });

  function addToCart(product: PosProductDto): void {
    setError(null);
    setCart((current) => {
      const existing = current.find((l) => l.product.productId === product.productId);
      if (existing) {
        const next = toDecimal(existing.qty).plus(1);
        return next.gt(toDecimal(product.availableQty))
          ? current
          : current.map((l) =>
              l.product.productId === product.productId ? { ...l, qty: next.toFixed(3) } : l,
            );
      }
      return [
        ...current,
        { product, qty: '1.000', unitPricePen: product.listPricePen ?? '0.0000' },
      ];
    });
  }

  function setLine(productId: string, patch: Partial<CartLine>): void {
    setCart((current) =>
      current.map((l) => (l.product.productId === productId ? { ...l, ...patch } : l)),
    );
  }

  const missingPrice = cart.some((l) => !new Decimal(l.unitPricePen || '0').gt(0));
  const badQty = cart.some(
    (l) =>
      !new Decimal(l.qty || '0').gt(0) ||
      new Decimal(l.qty || '0').gt(new Decimal(l.product.availableQty)),
  );
  const canSell = cart.length > 0 && method !== null && !missingPrice && !badQty && !sell.isPending;

  if (context.isPending) return <Skeleton className="h-64 w-full" />;

  return (
    <RoleGate allow={POS_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mostrador</h1>
          <p className="text-sm text-muted-foreground">
            Venta al contado de productos en stock, con entrega inmediata. Lo que se fabrica a
            medida va por cotización.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/pos/caja">Caja</Link>
        </Button>
      </div>

      {context.data && <ContingencyNotice context={context.data} />}

      {session === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Abre tu caja para vender</CardTitle>
          </CardHeader>
          <CardContent className="grid max-w-sm gap-3">
            <p className="text-sm text-muted-foreground">
              Escribe con cuánto efectivo arranca el cajón. Al cerrar el turno se compara contra lo
              que cuentes.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="pos-opening">Monto de apertura (S/)</Label>
              <Input
                id="pos-opening"
                inputMode="decimal"
                value={opening}
                onChange={(e) => {
                  setOpening(e.target.value);
                }}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button
              disabled={openSession.isPending}
              onClick={() => {
                openSession.mutate();
              }}
            >
              {openSession.isPending ? 'Abriendo…' : 'Abrir caja'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
          {/* Buscador y resultados */}
          <div className="grid content-start gap-3">
            <Input
              placeholder="Buscar por código o nombre…"
              autoFocus
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
            {products.isPending ? (
              <Skeleton className="h-64 w-full" />
            ) : (products.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay productos con saldo disponible para esa búsqueda.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {(products.data ?? []).map((p) => {
                  const otherLine = cartLine !== null && p.businessLine !== cartLine;
                  return (
                    <li key={p.productId}>
                      <button
                        type="button"
                        disabled={otherLine}
                        onClick={() => {
                          addToCart(p);
                        }}
                        className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">{p.sku}</span>
                          <span className="text-sm">
                            {p.listPricePen === null ? 'sin precio' : formatMoney(p.listPricePen)}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground">{p.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">{p.businessLineName}</Badge>
                          <span>disponible {formatQty(p.availableQty, unitSymbol(p.unit))}</span>
                          {otherLine && <span>· otra línea de negocio</span>}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Carrito y cobro */}
          <Card className="lg:sticky lg:top-4 lg:self-start">
            <CardHeader>
              <CardTitle>Venta</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {customer?.name ?? context.data?.genericCustomerName ?? 'Público en general'}
                  </span>
                  <div className="flex gap-1">
                    {customer !== null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCustomer(null);
                        }}
                      >
                        Quitar
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPickerOpen(true);
                      }}
                    >
                      {customer === null ? 'Identificar' : 'Cambiar'}
                    </Button>
                  </div>
                </div>
                {customer !== null && (
                  <p className="text-xs text-muted-foreground">
                    {customer.docType} {customer.docNumber} ·{' '}
                    {customer.docType === 'RUC' ? 'se emitirá factura' : 'se emitirá boleta'}
                  </p>
                )}
              </div>

              {cart.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Toca un producto para agregarlo al carrito.
                </p>
              ) : (
                <ul className="grid gap-3">
                  {cart.map((line) => {
                    const over = new Decimal(line.qty || '0').gt(
                      new Decimal(line.product.availableQty),
                    );
                    return (
                      <li key={line.product.productId} className="grid gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{line.product.sku}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setCart((c) =>
                                c.filter((l) => l.product.productId !== line.product.productId),
                              );
                            }}
                          >
                            Quitar
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="grid gap-1">
                            <Label className="text-xs" htmlFor={`qty-${line.product.productId}`}>
                              Cantidad ({unitSymbol(line.product.unit)})
                            </Label>
                            <Input
                              id={`qty-${line.product.productId}`}
                              inputMode="decimal"
                              value={line.qty}
                              aria-invalid={over}
                              onChange={(e) => {
                                setLine(line.product.productId, { qty: e.target.value });
                              }}
                            />
                          </div>
                          <div className="grid gap-1">
                            <Label className="text-xs" htmlFor={`price-${line.product.productId}`}>
                              Precio sin IGV
                            </Label>
                            <Input
                              id={`price-${line.product.productId}`}
                              inputMode="decimal"
                              value={line.unitPricePen}
                              onChange={(e) => {
                                setLine(line.product.productId, { unitPricePen: e.target.value });
                              }}
                            />
                          </div>
                        </div>
                        {over && (
                          <p className="text-xs text-destructive">
                            Solo hay {formatQty(line.product.availableQty)} disponibles.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="grid gap-1 border-t pt-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatMoney(toFixedString(totals.subtotal, 'MONEY'))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">IGV</span>
                  <span>{formatMoney(toFixedString(totals.igv, 'MONEY'))}</span>
                </div>
                <div className="flex justify-between text-base font-semibold">
                  <span>Total</span>
                  <span>{formatMoney(toFixedString(totals.total, 'MONEY'))}</span>
                </div>
              </div>

              {overGenericCap && (
                <p className="text-sm text-destructive" role="alert">
                  Una boleta a público en general no pasa de{' '}
                  {formatMoney(GENERIC_CUSTOMER_MAX_TOTAL_PEN)}: identifica al cliente.
                  {user.role === Role.ADMINISTRADOR &&
                    ' Como administrador puedes cobrarla igual; quedará registrado en el comprobante.'}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                {POS_PAYMENT_METHODS.map((m) => (
                  <Button
                    key={m}
                    variant={method === m ? 'default' : 'outline'}
                    onClick={() => {
                      setMethod(m);
                    }}
                  >
                    {PAYMENT_METHOD_LABELS[m]}
                  </Button>
                ))}
              </div>

              {method !== null && method !== 'CASH' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="pos-reference">Referencia (opcional)</Label>
                  <Input
                    id="pos-reference"
                    placeholder="Últimos dígitos, código de operación…"
                    value={reference}
                    onChange={(e) => {
                      setReference(e.target.value);
                    }}
                  />
                </div>
              )}

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button
                size="lg"
                disabled={!canSell || (overGenericCap && user.role !== Role.ADMINISTRADOR)}
                onClick={() => {
                  sell.mutate();
                }}
              >
                {sell.isPending
                  ? 'Cobrando…'
                  : `Cobrar ${formatMoney(toFixedString(totals.total, 'MONEY'))}`}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <CustomerPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPicked={(c) => {
          setCustomer(c);
        }}
      />

      <SaleDoneDialog
        sale={done}
        onClose={() => {
          setDone(null);
        }}
      />
    </RoleGate>
  );
}

/**
 * Lo que se ve cuando la venta ya está cerrada: el número del comprobante y su PDF.
 *
 * Si el comprobante quedó pendiente (D-073) lo dice acá y no en un banner general: es el
 * único momento en que alguien está esperando ese papel.
 */
function SaleDoneDialog({
  sale,
  onClose,
}: {
  sale: PosSaleListItemDto | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={sale !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Venta {sale?.code} cerrada</DialogTitle>
          <DialogDescription>
            {sale?.fiscalDocumentNumber ?? 'Comprobante'} por {formatMoney(sale?.totalPen ?? '0')} a{' '}
            {sale?.customerName}. La mercadería ya salió del almacén.
          </DialogDescription>
        </DialogHeader>
        {sale?.fiscalPending && (
          <p className="text-sm text-muted-foreground">
            El comprobante tomó su número y está pendiente de envío al PSE: se manda solo en cuanto
            haya conexión (contingencia, D-073). La venta no depende de eso.
          </p>
        )}
        <DialogFooter>
          {sale !== null && (
            <Button variant="outline" asChild>
              <a href={`/api/invoicing/documents/${sale.fiscalDocumentId}/pdf`}>Descargar PDF</a>
            </Button>
          )}
          <Button onClick={onClose}>Nueva venta</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
