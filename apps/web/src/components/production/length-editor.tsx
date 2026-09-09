'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EMPTY_PIECE_ROW, type PieceRow } from '@/lib/pieces';

/**
 * El editor de largos de coberturas: una fila por largo, con su cantidad y su ✕ (D-083).
 *
 * Vivía dentro de la terminal de planta y se movió acá con D-159, cuando el espacio de
 * producción pasó a usarlo en **dos** lugares por orden: el plan de corte y el reporte de lo
 * que salió. Son la misma captura —`cantidad × largo`— y tenerla dos veces era el camino
 * corto a que una de las dos dejara de validar lo que el API valida.
 *
 * `parsePieceRows` (en `@/lib/pieces`) es quien las convierte y quien dice por qué no.
 */
export function LengthEditor({
  rows,
  onChange,
  idPrefix,
  // Con valor por defecto y no opcional a secas: el ✕ se apaga con `disabled || una sola
  // fila`, y con `disabled` posiblemente `undefined` esa condición pedía `??`, que se queda
  // con el `false` del llamador y dejaba borrable la única fila.
  disabled = false,
  /** Rótulo de la columna de cantidad: `Planchas` en coberturas. */
  qtyLabel = 'Planchas',
}: {
  rows: readonly PieceRow[];
  onChange: (rows: PieceRow[]) => void;
  idPrefix: string;
  disabled?: boolean;
  qtyLabel?: string;
}) {
  const set = (i: number, patch: Partial<PieceRow>) => {
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  };

  return (
    <div className="grid gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="grid flex-1 gap-1">
            {i === 0 && <Label htmlFor={`${idPrefix}-largo-${String(i)}`}>Largo (m)</Label>}
            <Input
              id={`${idPrefix}-largo-${String(i)}`}
              aria-label={`Largo ${String(i + 1)} en metros`}
              inputMode="decimal"
              className="h-12 text-lg"
              placeholder="4.20"
              disabled={disabled}
              value={row.lengthM}
              onChange={(e) => {
                set(i, { lengthM: e.target.value });
              }}
            />
          </div>
          <div className="grid w-28 gap-1">
            {i === 0 && <Label htmlFor={`${idPrefix}-cant-${String(i)}`}>{qtyLabel}</Label>}
            <Input
              id={`${idPrefix}-cant-${String(i)}`}
              aria-label={`${qtyLabel} del largo ${String(i + 1)}`}
              inputMode="numeric"
              className="h-12 text-lg"
              placeholder="3"
              disabled={disabled}
              value={row.qty}
              onChange={(e) => {
                set(i, { qty: e.target.value });
              }}
            />
          </div>
          {/*
            D-159: **quitar una línea es parte de la captura**, no una corrección rara. Al
            montar la bobina el editor llega relleno con el plan que falta, y lo primero que
            hace el encargado que roló solo la mitad es borrar las que no salieron.

            La ✕ de la **única** fila también funciona: la vacía en vez de sacarla (el editor
            siempre muestra al menos una). Apagarla obligaba a borrar el largo y la cantidad a
            mano, campo por campo, justo cuando lo que se quiere es cerrar la orden sin
            reportar nada más.
          */}
          <Button
            type="button"
            variant="outline"
            className="h-12"
            aria-label={`Quitar el largo de la fila ${String(i + 1)}`}
            disabled={disabled}
            onClick={() => {
              onChange(rows.length === 1 ? [EMPTY_PIECE_ROW] : rows.filter((_, j) => j !== i));
            }}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="h-12 justify-self-start"
        disabled={disabled}
        onClick={() => {
          onChange([...rows, EMPTY_PIECE_ROW]);
        }}
      >
        Agregar otro largo
      </Button>
    </div>
  );
}
