'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { businessToday } from '@ayr/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/reports/segmented';
import {
  MONTH_PRESETS,
  PERIOD_PRESETS,
  PERIOD_PRESET_LABELS,
  completePeriod,
  defaultMonth,
  formatPeriodRange,
  fullMonth,
  matchMonthPreset,
  matchPreset,
  monthError,
  monthPeriod,
  periodError,
  presetMonth,
  presetPeriod,
  readStoredPeriod,
  sessionStore,
  writeStoredPeriod,
  type MonthPreset,
  type PeriodPreset,
  type ReportPeriod,
} from '@/lib/report-period';
import { useUrlState } from '@/lib/use-url-state';

export interface ReportPeriodState {
  period: ReportPeriod;
  /** El atajo que describe el periodo (el elegido, si dos coinciden), o `null` si es libre. */
  preset: PeriodPreset | null;
  /** La URL ya trae las dos fechas. Mientras no, no se pide nada al API. */
  complete: boolean;
  /** Completo y válido: se puede pedir el reporte. */
  valid: boolean;
  /** El mensaje del rango inválido, o `null`. */
  error: string | null;
  /** Cambia el periodo; `preset` es el atajo que lo eligió, si fue un atajo. */
  setPeriod: (period: ReportPeriod, preset?: PeriodPreset | null) => void;
}

/**
 * cc32: el periodo de un reporte, en la URL (`from`, `to`) también cuando es el predeterminado.
 *
 * Al abrir sin fechas, la URL se completa con `replace` usando el último periodo elegido en la
 * sesión (o el mes en curso). Lo guardado se lee en un efecto y no al pintar: el servidor no
 * tiene `sessionStorage` y la primera pintura tiene que coincidir con la suya. Un atajo se
 * recuerda como atajo (`writeStoredPeriod`), así «Este mes» sigue siendo este mes mañana.
 */
export function useReportPeriod(): ReportPeriodState {
  const [url, setUrl] = useUrlState({ from: '', to: '' });
  const search = useSearchParams().toString();
  const complete = url.from !== '' && url.to !== '';
  // El atajo que se eligió: en enero «Este mes» y «Este año» dan las mismas fechas.
  const [chosen, setChosen] = useState<PeriodPreset | null>(null);

  // `search` en las dependencias: otro `replace` de la misma pintura (la pestaña inválida que se
  // corrige, D-395) puede pisar este con la URL vieja; al volver sin fechas, se completa otra vez.
  useEffect(() => {
    if (complete) return;
    const today = businessToday();
    const next = completePeriod(url, today, readStoredPeriod(sessionStore(), today));
    setChosen(next.preset);
    setUrl({ from: next.from, to: next.to });
  }, [complete, search]);

  const period = { from: url.from, to: url.to };
  const error = complete ? periodError(period) : null;
  const valid = complete && error === null;
  const preset = complete ? matchPreset(period, businessToday(), chosen) : null;

  useEffect(() => {
    if (valid) {
      writeStoredPeriod(sessionStore(), { from: url.from, to: url.to }, preset, businessToday());
    }
  }, [valid, url.from, url.to, preset]);

  return {
    period,
    preset,
    complete,
    valid,
    error,
    setPeriod: (next, nextPreset = null) => {
      setChosen(nextPreset);
      setUrl({ from: next.from, to: next.to });
    },
  };
}

type PickerValue = PeriodPreset | 'custom';

/**
 * cc32: el selector de periodo, igual en todos los reportes: atajos, «Otro periodo…» con dos
 * fechas y el rango escrito al lado. `updating`: se está mostrando el dato del periodo anterior
 * mientras llega el nuevo (`useReportQueryState`), y se dice.
 */
export function PeriodPicker({
  state,
  updating = false,
}: {
  state: ReportPeriodState;
  updating?: boolean;
}) {
  const today = businessToday();
  const { period, complete } = state;
  // «Otro periodo…» abre las fechas aunque el rango coincida con un atajo.
  const [customOpen, setCustomOpen] = useState(false);
  const value: PickerValue | null = !complete
    ? null
    : customOpen || state.preset === null
      ? 'custom'
      : state.preset;

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
          state.setPeriod(presetPeriod(next, today), next);
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
      {updating && (
        <span role="status" className="text-sm text-muted-foreground" data-testid="actualizando">
          Actualizando…
        </span>
      )}
    </div>
  );
}

export interface ReportMonthState {
  month: string;
  /** La URL ya trae el mes. Mientras no, no se pide nada al API. */
  complete: boolean;
  valid: boolean;
  error: string | null;
  setMonth: (month: string) => void;
}

/**
 * cc32 (corte 2): el mes del Reporte mensual de bobinas, en la URL (`mes`) también cuando es el
 * predeterminado. Al abrir sin mes, se completa con el de la fecha final del último periodo
 * elegido en la sesión (o el mes en curso). Elegir un mes lo recuerda como periodo para el
 * siguiente reporte; abrir el reporte sin elegir nada no pisa lo recordado.
 */
export function useReportMonth(): ReportMonthState {
  const [url, setUrl] = useUrlState({ mes: '' });
  const search = useSearchParams().toString();
  const complete = url.mes !== '';

  useEffect(() => {
    if (complete) return;
    const today = businessToday();
    setUrl({ mes: defaultMonth(today, readStoredPeriod(sessionStore(), today)) });
  }, [complete, search]);

  const error = complete ? monthError(url.mes) : null;
  return {
    month: url.mes,
    complete,
    valid: complete && error === null,
    error,
    setMonth: (next) => {
      setUrl({ mes: next });
      if (monthError(next) === null) {
        // Con las reglas de guardado de la plantilla: el atajo si lo describe; si no, el rango.
        const today = businessToday();
        writeStoredPeriod(sessionStore(), monthPeriod(next, today), null, today);
      }
    },
  };
}

const MONTH_PRESET_LABELS: Record<MonthPreset, string> = {
  'this-month': 'Este mes',
  'last-month': 'Mes anterior',
};

type MonthPickerValue = MonthPreset | 'custom';

/** cc32 (corte 2): el selector de mes, con el mismo estilo que el de periodo. */
export function MonthPicker({
  state,
  updating = false,
}: {
  state: ReportMonthState;
  /** Se muestra el mes anterior mientras llega el nuevo (como `PeriodPicker`). */
  updating?: boolean;
}) {
  const today = businessToday();
  const { month, complete, valid } = state;
  const matched = complete ? matchMonthPreset(month, today) : null;
  const [customOpen, setCustomOpen] = useState(false);
  const value: MonthPickerValue | null = !complete
    ? null
    : customOpen || matched === null
      ? 'custom'
      : matched;
  // El mes entero, como el corte del API (en el mes en curso, el saldo de fin de mes es el de hoy).
  const period = valid ? fullMonth(month) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="periodo">
      <Segmented<MonthPickerValue>
        label="Mes"
        value={value}
        options={[
          ...MONTH_PRESETS.map((p) => ({ value: p, label: MONTH_PRESET_LABELS[p] })),
          { value: 'custom', label: 'Otro mes…' },
        ]}
        onChange={(next) => {
          if (next === 'custom') {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          state.setMonth(presetMonth(next, today));
        }}
      />
      {value === 'custom' && (
        <div className="flex items-center gap-2">
          <Label htmlFor="reporte-mes" className="text-xs text-muted-foreground">
            Mes
          </Label>
          <Input
            id="reporte-mes"
            type="month"
            className="h-8 w-auto"
            max={today.slice(0, 7)}
            value={month}
            onChange={(e) => {
              if (e.target.value) state.setMonth(e.target.value);
            }}
          />
        </div>
      )}
      {period && (
        <span className="text-sm text-muted-foreground" data-testid="periodo-rango">
          {formatPeriodRange(period)}
        </span>
      )}
      {updating && (
        <span role="status" className="text-sm text-muted-foreground" data-testid="actualizando">
          Actualizando…
        </span>
      )}
    </div>
  );
}
