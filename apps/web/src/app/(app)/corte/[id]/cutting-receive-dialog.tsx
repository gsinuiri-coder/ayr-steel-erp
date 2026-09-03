'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MIN_CHILD_WIDTH_MM,
  MIN_SPLIT_YIELD,
  type CuttingOrderCoilDto,
  type CuttingOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { isPositiveDecimal } from '@/lib/format';
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

interface WidthRow {
  widthMm: string;
  stripsCount: string;
}

function stripCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Recepción de una bobina de la orden (RF-41): el operario ingresa los flejes
 * realmente recibidos (ancho, cantidad, kg reales) más la merma de corte. El API
 * ejecuta el mismo `planCoilSplit` que el partido interno; acá solo se valida que el
 * plan quepa en el ancho de la bobina, igual que al enviarla.
 */
export function CuttingReceiveDialog({
  cuttingOrderId,
  row,
  open,
  onOpenChange,
  onDone,
}: {
  cuttingOrderId: string;
  row: CuttingOrderCoilDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<WidthRow[]>([{ widthMm: '', stripsCount: '1' }]);
  const [kerfLossMm, setKerfLossMm] = useState('0');
  const [receivedWeightKg, setReceivedWeightKg] = useState('');

  useEffect(() => {
    if (open) {
      setRows(
        row.widthPlanMm.length > 0
          ? row.widthPlanMm.map((p) => ({
              widthMm: p.widthMm,
              stripsCount: String(p.stripsCount),
            }))
          : [{ widthMm: '', stripsCount: '1' }],
      );
      setKerfLossMm(row.expectedKerfLossMm);
      setReceivedWeightKg(row.coilAvailableKg);
    }
  }, [open, row]);

  const receive = useMutation({
    mutationFn: () =>
      api<CuttingOrderDto>(`/cutting/${cuttingOrderId}/coils/${row.coilId}/receive`, {
        method: 'POST',
        body: {
          receivedWidthsMm: rows
            .filter((r) => r.widthMm.trim())
            .map((r) => ({ widthMm: r.widthMm.trim(), stripsCount: stripCount(r.stripsCount) })),
          receivedWeightKg: receivedWeightKg.trim(),
          kerfLossMm: kerfLossMm.trim() || '0',
        },
      }),
    onSuccess: () => {
      toast.success('Recepción registrada: flejes creados en el kardex');
      onOpenChange(false);
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo recibir'),
  });

  const preview = previewReceive(row, rows, kerfLossMm, receivedWeightKg);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Recibir {row.coilCode}</DialogTitle>
          <DialogDescription>
            Ancho de la bobina: {row.coilWidthMm} mm. Ingresa los flejes que realmente volvieron del
            tercero: pueden diferir del plan enviado.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="received-weight">Kg reales recibidos</Label>
              <Input
                id="received-weight"
                inputMode="decimal"
                value={receivedWeightKg}
                onChange={(e) => {
                  setReceivedWeightKg(e.target.value);
                }}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="kerf">Merma de corte (mm)</Label>
              <Input
                id="kerf"
                inputMode="decimal"
                value={kerfLossMm}
                onChange={(e) => {
                  setKerfLossMm(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Flejes recibidos</Label>
            {rows.map((r, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`Ancho de la fila ${index + 1} en mm`}
                  placeholder="Ancho (mm)"
                  inputMode="decimal"
                  value={r.widthMm}
                  onChange={(e) => {
                    setRows((prev) =>
                      prev.map((row2, i) =>
                        i === index ? { ...row2, widthMm: e.target.value } : row2,
                      ),
                    );
                  }}
                />
                <Input
                  aria-label={`Cantidad de la fila ${index + 1}`}
                  className="w-24"
                  inputMode="numeric"
                  value={r.stripsCount}
                  onChange={(e) => {
                    setRows((prev) =>
                      prev.map((row2, i) =>
                        i === index ? { ...row2, stripsCount: e.target.value } : row2,
                      ),
                    );
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={rows.length === 1}
                  onClick={() => {
                    setRows((prev) => prev.filter((_, i) => i !== index));
                  }}
                >
                  Quitar
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                setRows((prev) => [...prev, { widthMm: '', stripsCount: '1' }]);
              }}
            >
              Agregar ancho
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {preview.strips} fleje(s) · ancho consumido {preview.consumedWidthMm} mm de{' '}
                {row.coilWidthMm} mm
              </p>
              {preview.error && <p className="mt-1 text-destructive">{preview.error}</p>}
            </div>
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
            disabled={receive.isPending || !preview || Boolean(preview.error)}
            onClick={() => {
              receive.mutate();
            }}
          >
            {receive.isPending ? 'Recibiendo…' : 'Recibir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ReceivePreview {
  strips: number;
  consumedWidthMm: string;
  error: string | null;
}

/**
 * Recibir ejecuta el mismo `planCoilSplit` que el partido interno (RF-15): replica sus
 * mismas reglas (ancho mínimo por fleje, piso de aprovechamiento del 80%, presupuesto de
 * ancho), no solo el presupuesto de ancho, para no mostrar una previsualización en verde
 * que el servidor rebota igual que le pasaba al partido antes de que se corrigiera
 * (ver `coil-split-dialog.tsx`).
 */
function previewReceive(
  row: CuttingOrderCoilDto,
  rows: WidthRow[],
  kerfLossMm: string,
  receivedWeightKg: string,
): ReceivePreview | null {
  const validRows = rows.filter((r) => r.widthMm.trim());
  if (validRows.length === 0) return null;
  if (validRows.some((r) => !isPositiveDecimal(r.widthMm))) return null;
  if (!isPositiveDecimal(receivedWeightKg)) return null;

  const kerf = /^\d+(\.\d+)?$/.test(kerfLossMm.trim())
    ? new Decimal(kerfLossMm.trim())
    : new Decimal(0);
  const widths = validRows.flatMap((r) =>
    Array.from({ length: stripCount(r.stripsCount) }, () => new Decimal(r.widthMm.trim())),
  );
  const widthsTotal = widths.reduce((acc, w) => acc.plus(w), new Decimal(0));
  const consumed = widthsTotal.plus(kerf);
  const parentWidth = new Decimal(row.coilWidthMm);
  const minYieldWidth = parentWidth.times(MIN_SPLIT_YIELD);

  let error: string | null = null;
  if (widths.some((w) => w.lt(MIN_CHILD_WIDTH_MM))) {
    error = `El ancho de cada fleje debe ser de al menos ${MIN_CHILD_WIDTH_MM} mm.`;
  } else if (consumed.gt(parentWidth)) {
    error = `Los anchos más la merma suman ${consumed.toFixed(2)} mm y la bobina tiene ${row.coilWidthMm} mm.`;
  } else if (widthsTotal.lt(minYieldWidth)) {
    error = `Los flejes cubren ${widthsTotal.toFixed(2)} mm de ${row.coilWidthMm} mm: la recepción tiene que aprovechar al menos ${minYieldWidth.toFixed(2)} mm.`;
  } else if (new Decimal(receivedWeightKg.trim()).gt(new Decimal(row.coilAvailableKg))) {
    error = `Solo hay ${row.coilAvailableKg} kg disponibles en esta bobina.`;
  }

  return { strips: widths.length, consumedWidthMm: consumed.toFixed(2), error };
}
