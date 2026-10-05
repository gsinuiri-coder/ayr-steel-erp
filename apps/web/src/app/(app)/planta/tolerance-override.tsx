'use client';

import {
  TOLERANCE_OVERRIDE_REASON_LABELS,
  TOLERANCE_OVERRIDE_REASONS_OVER,
  toleranceOverrideSchema,
  type MountedKgExcess,
  type RoofingReportDraftDto,
  type ToleranceOverrideInput,
  type ToleranceOverrideReason,
} from '@ayr/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { formatQty } from '@/lib/format';

/** D-388/D-389: lo que se marcó para una fila fuera de tolerancia (la casilla y el motivo). */
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
 * D-389: el aviso de una fila que pasa la tolerancia del 1 % —con el texto fuerte pasado el 5 %—
 * y la casilla con el motivo. La marca **cualquiera que pueda reportar**: desde D-389 no hace
 * falta un administrador. Los motivos son los que aplican a un exceso hacia arriba.
 */
export function ToleranceOverrideRow({
  title,
  label,
  excess,
  value,
  onChange,
  disabled,
}: {
  /** El encabezado del aviso: «Fila 2 de OP-000034 (BOB…)» o «Reporte de OP-000034». */
  title: string;
  /** Lo que nombran los controles para el lector de pantalla: «la fila 2 de OP-000034». */
  label: string;
  excess: MountedKgExcess;
  value: ToleranceOverrideState;
  onChange: (next: ToleranceOverrideState) => void;
  disabled: boolean;
}) {
  const id = `tolerancia-${label.replace(/\W+/g, '-')}`;
  return (
    <div className="grid gap-2" data-severe={excess.severe ? 'true' : 'false'}>
      {excess.severe && (
        <p className="font-semibold">
          Diferencia mayor al {excess.maxPct} %: revisa cantidad, largo y bobina antes de confirmar.
        </p>
      )}
      <p>
        <strong>{title} fuera de tolerancia:</strong> lo reportado equivale a{' '}
        {formatQty(excess.theoreticalKg, 'kg')} y quedan {formatQty(excess.availableKg, 'kg')}{' '}
        montados. Diferencia {formatQty(excess.excessKg, 'kg')} ({excess.excessPct} % del teórico):
        pasa el {excess.tolerancePct} %. Para confirmar, marca la casilla y elige el motivo; se
        descuentan los {formatQty(excess.availableKg, 'kg')} montados y la bobina queda en 0.
      </p>
      <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,16rem)_minmax(0,1fr)] sm:items-center">
        <label className="flex items-center gap-2 font-medium" htmlFor={`${id}-check`}>
          <Checkbox
            id={`${id}-check`}
            aria-label={`Confirmar ${label} fuera de tolerancia`}
            checked={value.checked}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ ...value, checked: checked === true });
            }}
          />
          Confirmo el reporte fuera de tolerancia
        </label>
        <select
          aria-label={`Motivo de ${label}`}
          className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
          disabled={disabled || !value.checked}
          value={value.reason}
          onChange={(e) => {
            onChange({ ...value, reason: e.target.value as ToleranceOverrideReason | '' });
          }}
        >
          <option value="">Elige el motivo…</option>
          {TOLERANCE_OVERRIDE_REASONS_OVER.map((r) => (
            <option key={r} value={r}>
              {TOLERANCE_OVERRIDE_REASON_LABELS[r]}
            </option>
          ))}
        </select>
        <Input
          aria-label={`Detalle del motivo de ${label}`}
          placeholder={value.reason === 'OTHER' ? 'Explica el motivo' : 'Detalle (opcional)'}
          maxLength={200}
          disabled={disabled || !value.checked}
          value={value.detail}
          onChange={(e) => {
            onChange({ ...value, detail: e.target.value });
          }}
        />
      </div>
    </div>
  );
}

/**
 * D-388/D-389: el aviso de las filas del borrador que pasan la tolerancia del 1 %, cada una con
 * su casilla. Aparece **solo** cuando alguna fila lo necesita.
 */
export function ToleranceOverrideFields({
  orderCode,
  rows,
  value,
  onChange,
  disabled,
}: {
  orderCode: string;
  rows: readonly RoofingReportDraftDto[];
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
      {rows.map((d) =>
        d.outOfTolerance === null ? null : (
          <ToleranceOverrideRow
            key={d.id}
            title={`Fila ${String(d.rowNumber)} de ${orderCode} (${d.coilCode})`}
            label={`la fila ${String(d.rowNumber)} de ${orderCode}`}
            excess={d.outOfTolerance}
            value={value[d.id] ?? EMPTY_OVERRIDE}
            onChange={(next) => {
              onChange(d.id, next);
            }}
            disabled={disabled}
          />
        ),
      )}
    </div>
  );
}
