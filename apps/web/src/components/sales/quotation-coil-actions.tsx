'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QuotationDto, QuotationItemCoilCandidatesDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
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
import { Skeleton } from '@/components/ui/skeleton';

/**
 * D-385 (B): en una cotización importada, antes de confirmar, la bobina de una línea de bobina
 * **se quita o se cambia**. La que puso el importador es una sugerencia. Quitarla deja la línea
 * «sin bobina asignada» (se elige al confirmar, con el ±1 %); cambiarla ofrece las candidatas
 * del papel: mismo color, espesor dentro de la tolerancia y saldo ≥ los kilos del papel.
 */
export function QuotationCoilLineActions({
  quotationId,
  lineNumber,
  hasCoil,
  disabled,
}: {
  quotationId: string;
  lineNumber: number;
  hasCoil: boolean;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const candidates = useQuery({
    queryKey: ['quotation-coil-candidates', quotationId, lineNumber],
    queryFn: () =>
      api<QuotationItemCoilCandidatesDto>(
        `/sales/quotations/${quotationId}/items/${String(lineNumber)}/coil-candidates`,
      ),
    enabled: open,
    // Cada apertura vuelve a leer: otra cotización pudo tomar una bobina.
    staleTime: 0,
    gcTime: 0,
  });
  const setCoil = useMutation({
    mutationFn: (saleCoilId: string | null) =>
      api<QuotationDto>(`/sales/quotations/${quotationId}/items/${String(lineNumber)}/coil`, {
        method: 'PUT',
        body: { saleCoilId },
      }),
    onSuccess: (_q, saleCoilId) => {
      toast.success(
        saleCoilId === null
          ? `Línea ${String(lineNumber)}: sin bobina asignada; se elige al confirmar`
          : `Línea ${String(lineNumber)}: bobina cambiada`,
      );
      setOpen(false);
      invalidateSales(queryClient, { quotationId });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar la bobina');
    },
  });
  const busy = disabled || setCoil.isPending;
  const data = candidates.data;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() => {
          setOpen(true);
        }}
      >
        Cambiar bobina
      </Button>
      {hasCoil && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          pending={setCoil.isPending && setCoil.variables === null}
          pendingText="Quitando…"
          onClick={() => {
            if (busy) return;
            setCoil.mutate(null);
          }}
        >
          Quitar bobina
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Cambiar la bobina de la línea {lineNumber}</DialogTitle>
            <DialogDescription>
              Papel: <span className="font-mono">{data?.paperSku ?? '…'}</span>. Bobinas libres del
              mismo color, con espesor dentro de ±{data?.toleranceMm ?? '…'} mm y con los kilos del
              papel o más. La línea toma el producto de la bobina; los kilos y el importe siguen
              siendo los del papel. Para una bobina hasta 1 % más liviana, quita la bobina y elígela
              al confirmar.
            </DialogDescription>
          </DialogHeader>
          {candidates.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !data || data.candidates.length === 0 ? (
            <Alert>
              <AlertDescription>
                No hay ninguna bobina candidata. La línea puede quedar sin bobina y elegirse al
                confirmar.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-2">
              {data.candidates.map((c) => {
                const current = c.coilId === data.currentCoilId;
                return (
                  <div
                    key={c.coilId}
                    className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
                  >
                    <div>
                      <div className="font-medium">{c.code}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.productSku} · {c.thicknessMm} mm · {c.widthMm} mm ·{' '}
                        {formatQty(c.balanceKg, 'kg')}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={current ? 'secondary' : 'default'}
                      disabled={busy || current}
                      pending={setCoil.isPending && setCoil.variables === c.coilId}
                      pendingText="Cambiando…"
                      onClick={() => {
                        if (busy || current) return;
                        setCoil.mutate(c.coilId);
                      }}
                    >
                      {current ? 'La actual' : 'Usar esta'}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
