'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { businessToday } from '@ayr/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/reports/segmented';
import {
  PERIOD_PRESETS,
  PERIOD_PRESET_LABELS,
  completePeriod,
  formatPeriodRange,
  matchPreset,
  periodError,
  presetPeriod,
  readStoredPeriod,
  sessionStore,
  writeStoredPeriod,
  type PeriodPreset,
  type ReportPeriod,
} from '@/lib/report-period';
import { useUrlState } from '@/lib/use-url-state';

export interface ReportPeriodState {
  period: ReportPeriod;
  /** La URL ya trae las dos fechas. Mientras no, no se pide nada al API. */
  complete: boolean;
  /** Completo y válido: se puede pedir el reporte. */
  valid: boolean;
  /** El mensaje del rango inválido, o `null`. */
  error: string | null;
  setPeriod: (period: ReportPeriod) => void;
}

/**
 * cc32: el periodo de un reporte, en la URL (`from`, `to`) también cuando es el predeterminado.
 *
 * Al abrir sin fechas, la URL se completa con `replace` usando el último periodo elegido en la
 * sesión (o el mes en curso). Lo guardado se lee en un efecto y no al pintar: el servidor no
 * tiene `sessionStorage` y la primera pintura tiene que coincidir con la suya.
 */
export function useReportPeriod(): ReportPeriodState {
  const [url, setUrl] = useUrlState({ from: '', to: '' });
  const search = useSearchParams().toString();
  const complete = url.from !== '' && url.to !== '';

  // `search` en las dependencias: otro `replace` de la misma pintura (la pestaña inválida que se
  // corrige, D-395) puede pisar este con la URL vieja; al volver sin fechas, se completa otra vez.
  useEffect(() => {
    if (complete) return;
    setUrl(completePeriod(url, businessToday(), readStoredPeriod(sessionStore())));
  }, [complete, search]);

  const period = { from: url.from, to: url.to };
  const error = complete ? periodError(period) : null;
  const valid = complete && error === null;

  useEffect(() => {
    if (valid) writeStoredPeriod(sessionStore(), { from: url.from, to: url.to });
  }, [valid, url.from, url.to]);

  return {
    period,
    complete,
    valid,
    error,
    setPeriod: (next) => {
      setUrl({ from: next.from, to: next.to });
    },
  };
}

type PickerValue = PeriodPreset | 'custom';

/**
 * cc32: el selector de periodo, igual en todos los reportes: atajos, «Otro periodo…» con dos
 * fechas y el rango escrito al lado.
 */
export function PeriodPicker({ state }: { state: ReportPeriodState }) {
  const today = businessToday();
  const { period, complete } = state;
  const matched = complete ? matchPreset(period, today) : null;
  // «Otro periodo…» abre las fechas aunque el rango coincida con un atajo.
  const [customOpen, setCustomOpen] = useState(false);
  const value: PickerValue | null = !complete
    ? null
    : customOpen || matched === null
      ? 'custom'
      : matched;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="periodo">
      <Segmented<PickerValue>
        label="Periodo"
        value={value}
        options={[
          ...PERIOD_PRESETS.map((p) => ({ value: p, label: PERIOD_PRESET_LABELS[p] })),
          { value: 'custom', label: 'Otro periodo…' },
        ]}
        onChange={(next) => {
          if (next === 'custom') {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          state.setPeriod(presetPeriod(next, today));
        }}
      />
      {value === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="periodo-desde" className="text-xs text-muted-foreground">
            Desde
          </Label>
          <Input
            id="periodo-desde"
            type="date"
            className="h-8 w-auto"
            value={period.from}
            onChange={(e) => {
              if (e.target.value) state.setPeriod({ from: e.target.value, to: period.to });
            }}
          />
          <Label htmlFor="periodo-hasta" className="text-xs text-muted-foreground">
            Hasta
          </Label>
          <Input
            id="periodo-hasta"
            type="date"
            className="h-8 w-auto"
            value={period.to}
            onChange={(e) => {
              if (e.target.value) state.setPeriod({ from: period.from, to: e.target.value });
            }}
          />
        </div>
      )}
      {state.valid && (
        <span className="text-sm text-muted-foreground" data-testid="periodo-rango">
          {formatPeriodRange(period)}
        </span>
      )}
    </div>
  );
}
