'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CURRENCIES, CURRENCY_LABELS, type Currency, type CoilDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
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

/**
 * Editar una bobina (RF-20). Ancho y observaciones son libres con la bobina abierta;
 * moneda, tipo de cambio y costo por kg solo los ve un ADMINISTRADOR y recuestan el
 * ingreso vía reversa + nuevo movimiento (D-045), así que exigen motivo y solo se
 * admiten mientras la bobina no tenga movimientos posteriores a su ingreso.
 */
export function CoilEditDialog({
  coil,
  canEditCost,
  open,
  onOpenChange,
  onDone,
}: {
  coil: CoilDto;
  canEditCost: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [widthMm, setWidthMm] = useState(coil.widthMm);
  const [notes, setNotes] = useState(coil.notes ?? '');
  const [currency, setCurrency] = useState<Currency>(coil.currency);
  const [exchangeRate, setExchangeRate] = useState(coil.exchangeRate);
  const [unitCostPerKg, setUnitCostPerKg] = useState(coil.unitCostPerKg);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setWidthMm(coil.widthMm);
      setNotes(coil.notes ?? '');
      setCurrency(coil.currency);
      setExchangeRate(coil.exchangeRate);
      setUnitCostPerKg(coil.unitCostPerKg);
      setReason('');
    }
  }, [open, coil]);

  const costChanged =
    canEditCost &&
    (currency !== coil.currency ||
      exchangeRate.trim() !== coil.exchangeRate ||
      unitCostPerKg.trim() !== coil.unitCostPerKg);
  const widthChanged = widthMm.trim() !== coil.widthMm;
  const notesChanged = notes.trim() !== (coil.notes ?? '');

  const update = useMutation({
    mutationFn: () =>
      api<CoilDto>(`/coils/${coil.id}`, {
        method: 'PATCH',
        body: {
          ...(widthChanged ? { widthMm: widthMm.trim() } : {}),
          ...(notesChanged ? { notes: notes.trim() } : {}),
          ...(costChanged
            ? {
                currency,
                // En soles el tipo de cambio siempre es 1: mandarlo al revés lo rechaza
                // el schema compartido antes de llegar al API.
                exchangeRate: currency === 'PEN' ? '1' : exchangeRate.trim(),
                unitCostPerKg: unitCostPerKg.trim(),
                reason: reason.trim(),
              }
            : {}),
        },
      }),
    onSuccess: () => {
      toast.success(
        costChanged
          ? 'Bobina actualizada: el ingreso se recosteó en el kardex'
          : 'Bobina actualizada',
      );
      onOpenChange(false);
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo editar'),
  });

  const canSubmit =
    (widthChanged || notesChanged || costChanged) && (!costChanged || reason.trim().length >= 3);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar {coil.code}</DialogTitle>
          <DialogDescription>
            {canEditCost
              ? 'Cambiar la moneda, el tipo de cambio o el costo recuesta el ingreso en el kardex (D-045) y solo se puede si la bobina no se movió después.'
              : 'Ancho y observaciones. El costo y la moneda los edita un administrador.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="edit-width">Ancho (mm)</Label>
            <Input
              id="edit-width"
              inputMode="decimal"
              disabled={coil.status !== 'OPEN'}
              value={widthMm}
              onChange={(e) => {
                setWidthMm(e.target.value);
              }}
            />
            {coil.status !== 'OPEN' && (
              <p className="text-sm text-muted-foreground">
                El ancho solo se edita con la bobina abierta.
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="edit-notes">Observaciones</Label>
            <Input
              id="edit-notes"
              maxLength={500}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </div>

          {canEditCost && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label htmlFor="edit-currency">Moneda</Label>
                  <Select
                    value={currency}
                    onValueChange={(v) => {
                      setCurrency(v as Currency);
                      if (v === 'PEN') setExchangeRate('1.0000');
                    }}
                  >
                    <SelectTrigger id="edit-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CURRENCY_LABELS[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="edit-rate">Tipo de cambio</Label>
                  <Input
                    id="edit-rate"
                    inputMode="decimal"
                    disabled={currency === 'PEN'}
                    value={currency === 'PEN' ? '1.0000' : exchangeRate}
                    onChange={(e) => {
                      setExchangeRate(e.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="edit-cost">Costo por kg (sin IGV)</Label>
                <Input
                  id="edit-cost"
                  inputMode="decimal"
                  value={unitCostPerKg}
                  onChange={(e) => {
                    setUnitCostPerKg(e.target.value);
                  }}
                />
              </div>
              {costChanged && (
                <div className="grid gap-1">
                  <Label htmlFor="edit-reason">Motivo del recosteo</Label>
                  <Input
                    id="edit-reason"
                    maxLength={240}
                    placeholder="Por qué cambia el costo"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                    }}
                  />
                </div>
              )}
            </>
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
            disabled={!canSubmit || update.isPending}
            onClick={() => {
              update.mutate();
            }}
          >
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
