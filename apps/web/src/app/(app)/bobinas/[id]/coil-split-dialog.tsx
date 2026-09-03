'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Decimal, type CoilDto } from '@ayr/shared';
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
  count: string;
}

/**
 * Partir una bobina en hijas por ancho (RF-15). El formulario adelanta el mismo cálculo
 * que hace el API (peso prorrateado por ancho sobre `Σ anchos + merma de corte`) para
 * que el operario vea qué va a salir antes de confirmar; la cuenta que manda sigue
 * siendo la del servidor.
 */
export function CoilSplitDialog({
  coil,
  open,
  onOpenChange,
  onDone,
}: {
  coil: CoilDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<WidthRow[]>([{ widthMm: '', count: '1' }]);
  const [kerfLossMm, setKerfLossMm] = useState('0');
  const [splitWeightKg, setSplitWeightKg] = useState('');

  useEffect(() => {
    if (open) {
      setRows([{ widthMm: '', count: '1' }]);
      setKerfLossMm('0');
      setSplitWeightKg(coil.availableKg);
    }
  }, [open, coil.availableKg]);

  const split = useMutation({
    mutationFn: () =>
      api<CoilDto[]>(`/coils/${coil.id}/split`, {
        method: 'POST',
        body: {
          splitWeightKg,
          kerfLossMm: kerfLossMm.trim() || '0',
          children: rows.map((r) => ({
            widthMm: r.widthMm.trim(),
            count: Number.parseInt(r.count, 10) || 1,
          })),
        },
      }),
    onSuccess: (children) => {
      toast.success(`Partido registrado: ${children.length} bobina(s) hija(s)`);
      onOpenChange(false);
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo partir'),
  });

  const preview = previewSplit(coil, rows, kerfLossMm, splitWeightKg);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Partir {coil.code}</DialogTitle>
          <DialogDescription>
            Disponible: {coil.availableKg} kg · ancho de la madre: {coil.widthMm} mm. La suma de los
            anchos más la merma de corte no puede superar ese ancho.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="split-weight">Peso a partir (kg)</Label>
              <Input
                id="split-weight"
                inputMode="decimal"
                value={splitWeightKg}
                onChange={(e) => {
                  setSplitWeightKg(e.target.value);
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
            <Label>Anchos de las hijas</Label>
            {rows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`Ancho de la fila ${index + 1} en mm`}
                  placeholder="Ancho (mm)"
                  inputMode="decimal"
                  value={row.widthMm}
                  onChange={(e) => {
                    setRows((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, widthMm: e.target.value } : r)),
                    );
                  }}
                />
                <Input
                  aria-label={`Cantidad de tiras de la fila ${index + 1}`}
                  className="w-24"
                  inputMode="numeric"
                  value={row.count}
                  onChange={(e) => {
                    setRows((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, count: e.target.value } : r)),
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
                setRows((prev) => [...prev, { widthMm: '', count: '1' }]);
              }}
            >
              Agregar ancho
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {preview.strips} hija(s) · ancho consumido {preview.consumedWidthMm} mm de{' '}
                {coil.widthMm} mm
              </p>
              <p className="text-muted-foreground">
                Peso por hija (aprox.): {preview.perStrip.join(' · ')} kg. Merma de corte:{' '}
                {preview.kerfKg} kg.
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
            disabled={split.isPending || !preview || Boolean(preview.error)}
            onClick={() => {
              split.mutate();
            }}
          >
            {split.isPending ? 'Partiendo…' : 'Partir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SplitPreview {
  strips: number;
  consumedWidthMm: string;
  perStrip: string[];
  kerfKg: string;
  error: string | null;
}

/** Previsualización con `Decimal` (D-003): ni el ancho ni el peso pasan por `number`. */
function previewSplit(
  coil: CoilDto,
  rows: WidthRow[],
  kerfLossMm: string,
  splitWeightKg: string,
): SplitPreview | null {
  const valid = rows.filter((r) => isPositiveDecimal(r.widthMm));
  if (valid.length === 0 || !isPositiveDecimal(splitWeightKg)) return null;
  const kerf = /^\d+(\.\d+)?$/.test(kerfLossMm.trim())
    ? new Decimal(kerfLossMm.trim())
    : new Decimal(0);

  const widths = valid.flatMap((r) => {
    const count = Math.max(1, Number.parseInt(r.count, 10) || 1);
    return Array.from({ length: count }, () => new Decimal(r.widthMm.trim()));
  });
  const widthsTotal = widths.reduce((acc, w) => acc.plus(w), new Decimal(0));
  const consumed = widthsTotal.plus(kerf);
  const weight = new Decimal(splitWeightKg.trim());

  let error: string | null = null;
  if (consumed.gt(new Decimal(coil.widthMm))) {
    error = `Los anchos más la merma suman ${consumed.toFixed(2)} mm y la madre tiene ${coil.widthMm} mm.`;
  } else if (weight.gt(new Decimal(coil.availableKg))) {
    error = `Solo hay ${coil.availableKg} kg disponibles.`;
  }

  // El reparto va sobre el ancho de la MADRE, igual que el API: lo que no cubren las
  // tiras es recorte de borde y suma a la merma, no se reparte entre las hijas.
  const parentWidth = new Decimal(coil.widthMm);
  const perStrip = widths
    .slice(0, 6)
    .map((w) =>
      weight.times(w).div(parentWidth).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3),
    );
  if (widths.length > 6) perStrip.push('…');

  return {
    strips: widths.length,
    consumedWidthMm: consumed.toFixed(2),
    perStrip,
    kerfKg: weight
      .times(parentWidth.minus(widthsTotal))
      .div(parentWidth)
      .toDecimalPlaces(3, Decimal.ROUND_HALF_UP)
      .toFixed(3),
    error,
  };
}
