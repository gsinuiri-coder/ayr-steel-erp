'use client';

import {
  TOLERANCE_OVERRIDE_REASON_LABELS,
  TOLERANCE_OVERRIDE_REASONS,
  toleranceOverrideSchema,
  type RoofingReportDraftDto,
  type ToleranceOverrideInput,
  type ToleranceOverrideReason,
} from '@ayr/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { formatQty } from '@/lib/format';

/** D-388: lo que el administrador marcó para una fila del borrador. */
export interface ToleranceOverrideState {
  checked: boolean;
  reason: ToleranceOverrideReason | '';
  detail: string;
}

export const EMPTY_OVERRIDE: ToleranceOverrideState = { checked: false, reason: '', detail: '' };

/** La casilla de una fila, lista para viajar al API, o `null` si falta algo. */
export function overrideInput(
  state: ToleranceOverrideState | undefined,
): ToleranceOverrideInput | null {
  if (state === undefined || !state.checked || state.reason === '') return null;
  const parsed = toleranceOverrideSchema.safeParse({
    reason: state.reason,
    ...(state.detail.trim() === '' ? {} : { detail: state.detail.trim() }),
  });
  return parsed.success ? parsed.data : null;
}

/** Las filas del borrador que pasan la tolerancia y necesitan la casilla para ejecutarse. */
export function rowsOutOfTolerance(
  drafts: readonly RoofingReportDraftDto[],
): RoofingReportDraftDto[] {
  return drafts.filter((d) => d.outOfTolerance !== null);
}

/**
 * D-388: el aviso de las filas que pasan la tolerancia del 1 % y, para un administrador, la
 * casilla con el motivo. Aparece **solo** cuando alguna fila lo necesita. Quien no es
 * administrador ve el bloqueo y a quién pedírselo: la API lo rechaza igual.
 */
export function ToleranceOverrideFields({
  orderCode,
  rows,
  isAdmin,
  value,
  onChange,
  disabled,
}: {
  orderCode: string;
  rows: readonly RoofingReportDraftDto[];
  isAdmin: boolean;
  value: Readonly<Record<string, ToleranceOverrideState>>;
  onChange: (draftId: string, next: ToleranceOverrideState) => void;
  disabled: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      className="grid gap-3 rounded-lg border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
      data-testid="tolerance-override"
    >
      {rows.map((d) => {
        const excess = d.outOfTolerance;
        if (excess === null) return null;
        const state = value[d.id] ?? EMPTY_OVERRIDE;
        const id = `tolerancia-${d.id}`;
        return (
          <div key={d.id} className="grid gap-2">
            <p>
              <strong>
                Fila {d.rowNumber} de {orderCode} ({d.coilCode}) fuera de tolerancia:
              </strong>{' '}
              lo reportado equivale a {formatQty(excess.theoreticalKg, 'kg')} y quedan{' '}
              {formatQty(excess.availableKg, 'kg')} montados. Diferencia{' '}
              {formatQty(excess.excessKg, 'kg')} ({excess.excessPct} % del teórico): pasa el{' '}
              {excess.tolerancePct} %. Hasta el {excess.maxPct} % lo autoriza un administrador; se
              descuentan los {formatQty(excess.availableKg, 'kg')} montados y la bobina queda en 0.
            </p>
            {isAdmin ? (
              <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,16rem)_minmax(0,1fr)] sm:items-center">
                <label className="flex items-center gap-2 font-medium" htmlFor={`${id}-check`}>
                  <Checkbox
                    id={`${id}-check`}
                    aria-label={`Autorizar la fila ${String(d.rowNumber)} de ${orderCode} fuera de tolerancia`}
                    checked={state.checked}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      onChange(d.id, { ...state, checked: checked === true });
                    }}
                  />
                  Autorizo el reporte fuera de tolerancia
                </label>
                <select
                  aria-label={`Motivo de la fila ${String(d.rowNumber)} de ${orderCode}`}
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  disabled={disabled || !state.checked}
                  value={state.reason}
                  onChange={(e) => {
                    onChange(d.id, {
                      ...state,
                      reason: e.target.value as ToleranceOverrideReason | '',
                    });
                  }}
                >
                  <option value="">Elige el motivo…</option>
                  {TOLERANCE_OVERRIDE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {TOLERANCE_OVERRIDE_REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`Detalle del motivo de la fila ${String(d.rowNumber)} de ${orderCode}`}
                  placeholder={
                    state.reason === 'OTHER' ? 'Explica el motivo' : 'Detalle (opcional)'
                  }
                  maxLength={200}
                  disabled={disabled || !state.checked}
                  value={state.detail}
                  onChange={(e) => {
                    onChange(d.id, { ...state, detail: e.target.value });
                  }}
                />
              </div>
            ) : (
              <p className="font-medium">
                No se puede ejecutar así: lo autoriza un administrador desde esta misma pantalla.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
