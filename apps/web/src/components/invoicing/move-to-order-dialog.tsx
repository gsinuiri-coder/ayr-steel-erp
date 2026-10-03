'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  toDecimal,
  type FiscalDocumentDto,
  type MovableAnnulledDocumentDto,
  type MoveToOrderPreviewDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
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
import { Side, typedTotal } from './reactivate-with-order-lines-dialog';

function sellerLabel(s: { name: string | null }): string {
  return s.name ?? 'sin vendedor';
}

/**
 * D-381: **traer un comprobante manual anulado** a este pedido. Paso 1, elegir entre los anulados
 * manuales del cliente cuyo pedido está anulado (cada uno deshabilitado con el motivo que da la
 * API). Paso 2, la vista previa de D-378 con el pedido de origen y el destino, los vendedores, los
 * avisos de fecha y de despacho, el total del papel, el motivo y la casilla.
 *
 * Al terminar no abre el despacho a la fecha del papel (como hace D-378): el aviso dice que esa
 * fecha puede no tener stock (D-374) y el despacho se decide aparte, desde el comprobante.
 */
export function MoveToOrderDialog({
  order,
  open,
  onOpenChange,
}: {
  order: { id: string; code: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MovableAnnulledDocumentDto | null>(null);
  const [reason, setReason] = useState('');
  const [paperTotal, setPaperTotal] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setReason('');
      setPaperTotal('');
      setConfirmed(false);
    }
  }, [open]);

  const candidates = useQuery({
    queryKey: ['sales-order', order.id, 'movable-annulled-documents'],
    queryFn: () =>
      api<MovableAnnulledDocumentDto[]>(`/invoicing/orders/${order.id}/movable-annulled-documents`),
    enabled: open,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  // Uno solo disponible: ya viene elegido.
  useEffect(() => {
    if (!open || selected !== null || !candidates.data) return;
    const available = candidates.data.filter((c) => c.availability.ok);
    if (available.length === 1 && candidates.data.length === 1) setSelected(available[0] ?? null);
  }, [open, selected, candidates.data]);

  const preview = useQuery({
    queryKey: ['fiscal-document', selected?.id, 'move-to-order-preview', order.id],
    queryFn: () =>
      api<MoveToOrderPreviewDto>(
        `/invoicing/documents/${selected?.id ?? ''}/move-to-order/${order.id}/preview`,
      ),
    enabled: open && selected !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const move = useMutation({
    mutationFn: (body: {
      reason: string;
      confirmMatchesPaper: boolean;
      paperTotalPen: string;
      targetSalesOrderId: string;
    }) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${selected?.id ?? ''}/move-to-order`, {
        method: 'POST',
        body,
      }),
    onSuccess: (doc) => {
      toast.success(
        `${doc.number ?? 'Comprobante'} traído a ${order.code}. Las líneas quedan pendientes de despacho.`,
      );
      onOpenChange(false);
      // Los dos pedidos cambian: el de origen pierde el comprobante y el destino lo gana
      // (autorrevisión del diseño, P2).
      invalidateInvoicing(queryClient, { documentId: doc.id, orderId: order.id });
      if (selected?.sourceOrderId) {
        void queryClient.invalidateQueries({ queryKey: ['sales-order', selected.sourceOrderId] });
      }
      router.push(`/comprobantes/${doc.id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo traer el comprobante');
      void preview.refetch();
    },
  });

  const trimmed = reason.trim();
  const typed = typedTotal(paperTotal);
  const linesTotal = preview.data ? toDecimal(preview.data.after.totalPen).toFixed(2) : null;
  const difference =
    typed !== null && linesTotal !== null ? toDecimal(typed).minus(toDecimal(linesTotal)) : null;
  const matches = difference?.isZero() === true;
  const ready = preview.isSuccess && trimmed.length >= 3 && confirmed && matches;
  const p = preview.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Traer comprobante anulado a {order.code}</DialogTitle>
          <DialogDescription>
            Un comprobante manual anulado cuyo pedido también está anulado pasa a este pedido con
            sus líneas. Conserva número, serie, fecha, cliente y vencimiento: son los del papel. No
            crea despacho.
          </DialogDescription>
        </DialogHeader>

        <section aria-label="Comprobantes anulados del cliente" className="grid gap-1">
          {candidates.isPending && <p className="text-sm text-muted-foreground">Buscando…</p>}
          {candidates.isError && (
            <p role="alert" className="text-sm text-destructive">
              {candidates.error instanceof ApiError
                ? candidates.error.message
                : 'No se pudo leer la lista de anulados'}
            </p>
          )}
          {candidates.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              El cliente no tiene comprobantes manuales anulados de pedidos anulados.
            </p>
          )}
          {candidates.data?.map((c) => (
            <label
              key={c.id}
              className="flex items-start gap-2 rounded border p-2 text-sm"
              data-testid={`movable-${c.number ?? c.id}`}
            >
              <input
                type="radio"
                name="movable-document"
                className="mt-1"
                checked={selected?.id === c.id}
                disabled={!c.availability.ok}
                onChange={() => {
                  setSelected(c);
                  setPaperTotal('');
                  setConfirmed(false);
                }}
              />
              <span className="grid gap-0.5">
                <span>
                  <span className="font-medium">{c.number ?? 'Sin número'}</span> · {c.docType} ·{' '}
                  {formatDate(c.issueDate)} · {formatMoney(c.totalPen)} · pedido{' '}
                  {c.sourceOrderCode ?? '—'}
                </span>
                <span className="text-muted-foreground">Anulado: {c.annulReason ?? '—'}</span>
                {!c.availability.ok && c.availability.reason && (
                  <span className="text-destructive">{c.availability.reason}</span>
                )}
              </span>
            </label>
          ))}
        </section>

        {selected && preview.isPending && (
          <p className="text-sm text-muted-foreground">Calculando…</p>
        )}
        {preview.isError && (
          <p role="alert" className="text-sm text-destructive">
            {preview.error instanceof ApiError
              ? preview.error.message
              : 'No se pudo calcular la vista previa'}
          </p>
        )}
        {p && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Pedido</dt>
              <dd data-testid="move-orders">
                {p.sourceOrderCode} → {p.targetOrderCode}
              </dd>
              <dt className="text-muted-foreground">Vendedor</dt>
              <dd data-testid="move-sellers">
                {sellerLabel(p.sellerBefore)} → {sellerLabel(p.sellerAfter)}
              </dd>
              <dt className="text-muted-foreground">Fecha del papel</dt>
              <dd>
                {formatDate(p.issueDate)} (pedido {p.targetOrderCode}:{' '}
                {formatDate(p.targetOrderIssueDate)})
              </dd>
            </dl>
            <ul
              className="grid list-disc gap-1 pl-5 text-sm text-amber-700 dark:text-amber-400"
              data-testid="move-warnings"
            >
              {p.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
              <li>Después de traerlo, {p.targetOrderCode} ya no se edita (tiene comprobante).</li>
            </ul>
            <div className="grid gap-4 md:grid-cols-2">
              <Side title="Antes" testId="before" side={p.before} />
              <Side title="Después" testId="after" side={p.after} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="move-total">Total del papel vigente (S/)</Label>
              <Input
                id="move-total"
                inputMode="decimal"
                className="max-w-48"
                value={paperTotal}
                placeholder="0.00"
                onChange={(e) => {
                  setPaperTotal(e.target.value);
                }}
              />
              {paperTotal.trim().length > 0 && typed === null && (
                <p className="text-sm text-destructive">
                  Escribe el total con hasta dos decimales, por ejemplo 153.44.
                </p>
              )}
              {difference !== null && !matches && linesTotal !== null && typed !== null && (
                <p
                  aria-live="polite"
                  className="text-sm text-destructive"
                  data-testid="paper-total-mismatch"
                >
                  No coincide: papel {formatMoney(typed)} · estas líneas {formatMoney(linesTotal)} ·
                  diferencia {formatMoney(difference.toFixed(2))}
                </p>
              )}
              <Label htmlFor="move-reason">Motivo</Label>
              <Input
                id="move-reason"
                value={reason}
                maxLength={240}
                placeholder="Por qué el comprobante pasa a este pedido"
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
              {trimmed.length > 0 && trimmed.length < 3 && (
                <p className="text-sm text-destructive">
                  Explica el motivo en al menos 3 caracteres.
                </p>
              )}
              <span className="flex items-start gap-2">
                <Checkbox
                  id="move-confirm"
                  checked={confirmed}
                  onCheckedChange={(checked) => {
                    setConfirmed(checked === true);
                  }}
                />
                <Label htmlFor="move-confirm" className="leading-snug">
                  Confirmo que el comprobante, con estas líneas y en este pedido, coincide con el
                  papel vigente
                </Label>
              </span>
            </div>
          </>
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
            disabled={!ready || move.isPending}
            pending={move.isPending}
            pendingText="Trayendo…"
            onClick={() => {
              if (!ready || typed === null || move.isPending) return;
              move.mutate({
                reason: trimmed,
                confirmMatchesPaper: confirmed,
                paperTotalPen: typed,
                targetSalesOrderId: order.id,
              });
            }}
          >
            Traer comprobante
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
