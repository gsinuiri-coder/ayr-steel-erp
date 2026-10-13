'use client';

import { useState, type ReactElement } from 'react';
import {
  AT_COST_NOTE_MAX,
  AT_COST_REASON_LABELS,
  AT_COST_REASONS,
  atCostReasonText,
  type AtCostReason,
} from '@ayr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAmount } from '@/lib/format';

/** cc51 (D-641): la marca de una línea vendida a costo, mientras se edita. */
export interface AtCostDraft {
  reason: AtCostReason;
  /** El texto de «Otro»; vacío con los demás motivos. */
  note: string;
}

/** La etiqueta «A costo» con su motivo, igual en cotización, pedido y comprobante. */
export function AtCostBadge({
  reason,
  note,
}: {
  reason: string | null;
  note: string | null;
}): ReactElement | null {
  const text = atCostReasonText(reason, note);
  if (text === null) return null;
  return (
    <Badge variant="warning" className="whitespace-normal" title={`Vendida a costo · ${text}`}>
      A costo · {text}
    </Badge>
  );
}

/**
 * cc51 (D-641): vender una línea de la cotización a costo. Solo lo ve el ADMINISTRADOR
 * (`canMark`); el precio que se aplica es el costo con IGV que calculó el API, y por debajo de él
 * el API rechaza. Un VENDEDOR ve la etiqueta de una línea que ya estaba a costo, sin la opción.
 */
export function AtCostControl({
  atCost,
  canMark,
  atCostPricePen,
  unitLabel,
  onMark,
  onClear,
}: {
  atCost: AtCostDraft | undefined;
  canMark: boolean;
  /** El precio a costo con IGV, en la unidad del campo; null si no hay costo de referencia. */
  atCostPricePen: string | null;
  unitLabel: string;
  onMark: (mark: AtCostDraft, pricePen: string) => void;
  onClear: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AtCostReason | ''>('');
  const [note, setNote] = useState('');

  if (atCost) {
    return (
      <span className="mt-1 flex flex-wrap items-center justify-end gap-x-2 text-xs">
        <AtCostBadge reason={atCost.reason} note={atCost.note === '' ? null : atCost.note} />
        {canMark && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={onClear}
          >
            Quitar
          </Button>
        )}
      </span>
    );
  }
  if (!canMark || atCostPricePen === null) return null;

  const noteNeeded = reason === 'OTRO';
  const ready = reason !== '' && (!noteNeeded || note.trim() !== '');
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason('');
          setNote('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0 text-xs">
          Vender a costo
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3">
        <p className="text-sm">
          A costo:{' '}
          <span className="font-medium tabular-nums">{formatAmount(atCostPricePen, 2)}</span>{' '}
          {unitLabel} con IGV. Por debajo del costo no se vende.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="a-costo-motivo">Motivo</Label>
          <Select
            value={reason}
            onValueChange={(v) => {
              setReason(v as AtCostReason);
            }}
          >
            <SelectTrigger id="a-costo-motivo">
              <SelectValue placeholder="Elige el motivo" />
            </SelectTrigger>
            <SelectContent>
              {AT_COST_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {AT_COST_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {noteNeeded && (
          <div className="grid gap-1.5">
            <Label htmlFor="a-costo-texto">¿Cuál?</Label>
            <Input
              id="a-costo-texto"
              value={note}
              maxLength={AT_COST_NOTE_MAX}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </div>
        )}
        <Button
          type="button"
          disabled={!ready}
          onClick={() => {
            if (reason === '') return;
            onMark({ reason, note: noteNeeded ? note.trim() : '' }, atCostPricePen);
            setOpen(false);
          }}
        >
          Aplicar precio a costo
        </Button>
      </PopoverContent>
    </Popover>
  );
}
