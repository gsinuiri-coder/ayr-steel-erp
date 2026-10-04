'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toDecimal, type OrderCancelPreviewDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { unitSymbol } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

/**
 * D-383: «Anular pedido». Antes de confirmar pide al API qué pasaría (`cancel-preview`, sin
 * bloqueos) y lo muestra:
 *
 * - **bloqueos** —OP en curso, comprobante vivo, despachos vigentes—: el botón se apaga y cada
 *   uno dice qué hacer primero;
 * - **producto fabricado sin despachar**, por línea (SKU, cantidad, OP), con lo que va a pasar y
 *   una casilla que el API exige (`acknowledgeFabricated`);
 * - **comprobantes manuales anulados**: si el papel sigue vigente, conviene corregir el pedido y
 *   reactivar con sus líneas (D-378) en vez de anularlo.
 *
 * El API vuelve a comprobar todo con sus locks al anular.
 */
export function CancelOrderDialog({
  order,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  order: { id: string; code: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: (input: { reason: string; acknowledgeFabricated: boolean }) => void;
}) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setAcknowledged(false);
    }
  }, [open]);

  const preview = useQuery({
    queryKey: ['sales-order', order.id, 'cancel-preview'],
    queryFn: () => api<OrderCancelPreviewDto>(`/sales/orders/${order.id}/cancel-preview`),
    enabled: open,
    retry: false,
    // Lo que bloquea cambia con lo que otros hagan en el pedido: siempre fresca al abrir.
    staleTime: 0,
    gcTime: 0,
  });

  const p = preview.data;
  const trimmed = reason.trim();
  const blocked = p !== undefined && p.blocks.length > 0;
  const needsAck = p !== undefined && p.fabricated.length > 0;
  const ready = preview.isSuccess && !blocked && trimmed.length >= 3 && (!needsAck || acknowledged);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Anular {order.code}</DialogTitle>
          <DialogDescription>
            Libera las reservas activas y devuelve el material al disponible. Si el pedido vino de
            una cotización vigente, esa cotización vuelve a estar emitida.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending && <p className="text-sm text-muted-foreground">Revisando el pedido…</p>}
        {preview.isError && (
          <p role="alert" className="text-sm text-destructive">
            {preview.error instanceof ApiError
              ? preview.error.message
              : 'No se pudo revisar el pedido'}
          </p>
        )}

        {blocked && (
          <section aria-label="No se puede anular" className="grid gap-1">
            <p className="text-sm font-medium">No se puede anular todavía:</p>
            <ul
              className="grid list-disc gap-1 pl-5 text-sm text-destructive"
              data-testid="cancel-blocks"
            >
              {p.blocks.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </section>
        )}

        {p && p.annulledManualDocuments.length > 0 && (
          <p
            className="text-sm text-amber-700 dark:text-amber-400"
            data-testid="cancel-annulled-manual"
          >
            Este pedido tiene{' '}
            {p.annulledManualDocuments.length === 1
              ? 'el comprobante manual anulado'
              : 'los comprobantes manuales anulados'}{' '}
            {p.annulledManualDocuments.map((d) => d.number ?? 'sin número').join(', ')}. Si el papel
            sigue vigente y lo que está mal es el pedido, no lo anules: corrige el pedido y usa
            «Reactivar con las líneas del pedido». Después de anularlo, solo se podrá traer a otro
            pedido.
          </p>
        )}

        {needsAck && !blocked && (
          <section aria-label="Producto fabricado sin despachar" className="grid gap-2">
            <p className="text-sm font-medium">Producto fabricado que todavía no salió:</p>
            <ul className="grid gap-1 text-sm" data-testid="cancel-fabricated">
              {p.fabricated.map((l) => (
                <li key={l.salesOrderItemId}>
                  Línea {l.lineNumber} · <span className="font-medium">{l.sku}</span> ·{' '}
                  {toDecimal(l.qty).toString()} {unitSymbol(l.unit)} ·{' '}
                  {l.productionOrders.map((o) => o.code).join(', ')}
                  {l.madeToOrder ? ' · queda suelto' : ' · queda libre para otros pedidos'}
                </li>
              ))}
            </ul>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Al anular, lo fabricado queda en inventario sin pedido.
              {p.fabricated.some((l) => l.madeToOrder) &&
                ' Lo fabricado contra pedido (coberturas, planchas, accesorios) no lo toma ningún pedido nuevo ni el mostrador: queda suelto hasta revertir la producción (reabrir la orden y revertir sus reportes).'}
              {p.fabricated.some((l) => !l.madeToOrder) &&
                ' Lo que es producto de stock queda libre y otro pedido lo puede reservar.'}
            </p>
            <span className="flex items-start gap-2">
              <Checkbox
                id="cancel-ack-fabricated"
                checked={acknowledged}
                onCheckedChange={(checked) => {
                  setAcknowledged(checked === true);
                }}
              />
              <Label htmlFor="cancel-ack-fabricated" className="leading-snug">
                Entiendo que lo fabricado queda en inventario sin pedido
              </Label>
            </span>
          </section>
        )}

        {p && !blocked && (
          <div className="grid gap-2">
            <Label htmlFor="cancel-order-reason">Motivo</Label>
            <Input
              id="cancel-order-reason"
              value={reason}
              maxLength={240}
              placeholder="Por qué se anula el pedido"
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
            {trimmed.length > 0 && trimmed.length < 3 && (
              <p className="text-sm text-destructive">
                Explica el motivo en al menos 3 caracteres.
              </p>
            )}
          </div>
        )}

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
            variant="destructive"
            disabled={!ready || pending}
            pending={pending}
            pendingText="Anulando…"
            onClick={() => {
              if (!ready || pending) return;
              onConfirm({ reason: trimmed, acknowledgeFabricated: needsAck && acknowledged });
            }}
          >
            Anular pedido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
