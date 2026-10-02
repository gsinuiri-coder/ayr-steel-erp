'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FiscalDocumentOrigin,
  toDecimal,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type ReactivationPreviewDto,
  type ReactivationSideDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatTimestampDate } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { canReactivate, DISPATCH_AT_DOCUMENT_DATE } from './reactivate-document-dialog';

/**
 * D-378: lo que la API acepta reactivar con las líneas del pedido —un manual anulado de un
 * pedido—. La API vuelve a comprobar todos los bloqueos y la vista previa los muestra.
 */
export function canReactivateWithOrderLines(
  d: Pick<
    FiscalDocumentListItemDto,
    'docType' | 'status' | 'origin' | 'archivedAt' | 'salesOrderId'
  >,
): boolean {
  return canReactivate(d) && d.origin === FiscalDocumentOrigin.MANUAL && d.salesOrderId !== null;
}

/**
 * El total tipeado, si es un importe válido con hasta dos decimales. La coma solo se acepta como
 * separador de miles bien puesto (`1,234.50`): `153,44` no se lee como 15344 (revisión cc13, P3-6).
 */
function typedTotal(value: string): string | null {
  const v = value.trim();
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(v)) return null;
  return toDecimal(v.replace(/,/g, '')).toFixed(2);
}

function Side({
  title,
  testId,
  side,
}: {
  title: string;
  testId: string;
  side: ReactivationSideDto;
}) {
  return (
    <section aria-label={title} className="grid gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">N.°</TableHead>
            <TableHead>Descripción</TableHead>
            <TableHead className="text-right">Cant.</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {side.lines.map((l) => (
            <TableRow key={l.lineNumber}>
              <TableCell className="tabular-nums">{l.lineNumber}</TableCell>
              <TableCell>
                {l.description}
                <span className="ml-1 text-xs text-muted-foreground">
                  (línea {l.orderLineNumber} del pedido)
                </span>
                {l.added && (
                  <Badge variant="secondary" className="ml-2">
                    Agregada
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {toDecimal(l.qty).toString()} {l.unit}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(l.totalPen)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={3} className="text-right">
              Gravada
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(side.subtotalPen)}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={3} className="text-right">
              IGV
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(side.igvPen)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={3} className="text-right font-medium">
              Total
            </TableCell>
            <TableCell
              className="text-right font-medium tabular-nums"
              data-testid={`${testId}-total`}
            >
              {formatMoney(side.totalPen)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </section>
  );
}

/**
 * D-378: reactivar un comprobante manual anulado **con las líneas actuales del pedido**. Muestra
 * el antes y el después (líneas, gravada, IGV y total); pide motivo, el total del papel y la
 * casilla. Solo deja reactivar si el total tipeado coincide al céntimo, y si no muestra los dos y
 * la diferencia. No despacha: las líneas agregadas quedan pendientes y se despachan con D-364.
 */
export function ReactivateWithOrderLinesDialog({
  document: d,
  open,
  onOpenChange,
}: {
  document: Pick<
    FiscalDocumentListItemDto,
    'id' | 'number' | 'salesOrderId' | 'annulledAt' | 'annulledByName' | 'annulReason'
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [paperTotal, setPaperTotal] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setPaperTotal('');
      setConfirmed(false);
    }
  }, [open]);

  const preview = useQuery({
    queryKey: ['fiscal-document', d.id, 'reactivate-with-order-lines-preview'],
    queryFn: () =>
      api<ReactivationPreviewDto>(
        `/invoicing/documents/${d.id}/reactivate-with-order-lines/preview`,
      ),
    enabled: open,
    retry: false,
    // Los bloqueos cambian con lo que otros hagan en el pedido: siempre fresca al abrir.
    staleTime: 0,
    gcTime: 0,
  });

  const reactivate = useMutation({
    mutationFn: (body: { reason: string; confirmMatchesPaper: boolean; paperTotalPen: string }) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${d.id}/reactivate-with-order-lines`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      toast.success(
        `${d.number ?? 'Comprobante'} reactivado con las líneas del pedido. Las líneas agregadas quedan pendientes de despacho.`,
      );
      onOpenChange(false);
      invalidateInvoicing(queryClient, {
        documentId: d.id,
        orderId: d.salesOrderId ?? undefined,
      });
      router.push(`/comprobantes/${d.id}?despacho=${DISPATCH_AT_DOCUMENT_DATE}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo reactivar');
      // Autorrevisión cc13 (P3): si el pedido cambió mientras el diálogo estaba abierto, el antes
      // y el después que se ven ya no son los que la API calculó: se vuelven a pedir.
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Reactivar {d.number ?? 'comprobante'} con las líneas del pedido</DialogTitle>
          <DialogDescription>
            El comprobante vuelve a estar aceptado facturando el pedido entero
            {preview.data ? ` (${preview.data.salesOrderCode})` : ''}. Conserva número, serie, fecha
            y cliente. No crea despacho: las líneas agregadas quedan pendientes y las originales
            conservan el suyo.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Anulado</dt>
          <dd>
            {d.annulledAt ? formatTimestampDate(d.annulledAt) : '—'}
            {d.annulledByName ? ` · ${d.annulledByName}` : ''}
          </dd>
          <dt className="text-muted-foreground">Motivo</dt>
          <dd>{d.annulReason ?? '—'}</dd>
        </dl>

        {preview.isPending && <p className="text-sm text-muted-foreground">Calculando…</p>}
        {preview.isError && (
          <p role="alert" className="text-sm text-destructive">
            {preview.error instanceof ApiError
              ? preview.error.message
              : 'No se pudo calcular la vista previa'}
          </p>
        )}
        {preview.data && (
          <div className="grid gap-4 md:grid-cols-2">
            <Side title="Antes" testId="before" side={preview.data.before} />
            <Side title="Después" testId="after" side={preview.data.after} />
          </div>
        )}

        {preview.data && (
          <div className="grid gap-2">
            <Label htmlFor="reactivate-lines-total">Total del papel vigente (S/)</Label>
            <Input
              id="reactivate-lines-total"
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
            <Label htmlFor="reactivate-lines-reason">Motivo de la reactivación</Label>
            <Input
              id="reactivate-lines-reason"
              value={reason}
              maxLength={240}
              placeholder="Por qué se reactiva con otras líneas"
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
                id="reactivate-lines-confirm"
                checked={confirmed}
                onCheckedChange={(checked) => {
                  setConfirmed(checked === true);
                }}
              />
              <Label htmlFor="reactivate-lines-confirm" className="leading-snug">
                Confirmo que el comprobante, con estas líneas, coincide con el papel vigente
              </Label>
            </span>
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
            disabled={!ready || reactivate.isPending}
            pending={reactivate.isPending}
            pendingText="Reactivando…"
            onClick={() => {
              if (!ready || typed === null || reactivate.isPending) return;
              reactivate.mutate({
                reason: trimmed,
                confirmMatchesPaper: confirmed,
                paperTotalPen: typed,
              });
            }}
          >
            Reactivar con estas líneas
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
