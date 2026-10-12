'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { businessToday } from '@ayr/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/reports/segmented';
import { FiltersDialog } from '@/components/table-toolbar';
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
    const next = completePeriod(
      { from: url.from, to: url.to },
      today,
      readStoredPeriod(sessionStore(), today),
    );
    setChosen(next.preset);
    setUrl({ from: next.from, to: next.to });
  }, [complete, search, url.from, url.to, setUrl]);

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

/** cc47 (D-615): el periodo como borrador del modal de filtros. */
export interface PeriodDraft {
  from: string;
  to: string;
  /** El atajo que lo eligió, o `null` si es un rango libre. */
  preset: PeriodPreset | null;
}

/** cc47: el borrador que parte del periodo aplicado. */
export function periodDraftOf(state: ReportPeriodState): PeriodDraft {
  return { from: state.period.from, to: state.period.to, preset: state.preset };
}

/** cc47: el periodo sin filtro elegido: «Este mes». */
export function defaultPeriodDraft(): PeriodDraft {
  return { ...presetPeriod('this-month', businessToday()), preset: 'this-month' };
}

/**
 * cc47: el periodo cuenta como filtro activo cuando no es «Este mes», el predeterminado. El atajo
 * elegido manda (en enero, «Este año» da las mismas fechas que «Este mes» y es otra elección).
 */
export function periodIsFiltered(state: ReportPeriodState): boolean {
  if (!state.complete) return false;
  if (state.preset !== null) return state.preset !== 'this-month';
  const base = presetPeriod('this-month', businessToday());
  return state.period.from !== base.from || state.period.to !== base.to;
}

/** cc47: el mensaje que impide aplicar el periodo del borrador, o `null`. */
export function periodDraftError(draft: PeriodDraft): string | null {
  if (draft.from === '' || draft.to === '') return 'Elige las dos fechas del periodo.';
  return periodError({ from: draft.from, to: draft.to });
}

/**
 * cc47 (D-615): el periodo dentro del modal de filtros — los mismos atajos y «Otro periodo…» que
 * `PeriodPicker`, pero sobre un borrador: no cambia la URL hasta «Aplicar».
 */
export function PeriodFields({
  draft,
  onChange,
}: {
  draft: PeriodDraft;
  onChange: (next: PeriodDraft) => void;
}) {
  const today = businessToday();
  const [customOpen, setCustomOpen] = useState(draft.preset === null);
  const value: PickerValue = customOpen || draft.preset === null ? 'custom' : draft.preset;
  const valid = periodDraftError(draft) === null;
  return (
    <div className="grid gap-2" data-testid="periodo">
      <Segmented<PickerValue>
        label="Periodo"
        showLabel
        value={value}
        options={[
          ...PERIOD_PRESETS.map((p) => ({ value: p, label: PERIOD_PRESET_LABELS[p] })),
          { value: 'custom', label: 'Otro periodo…' },
        ]}
        onChange={(next) => {
          if (next === 'custom') {
            setCustomOpen(true);
            onChange({ ...draft, preset: null });
            return;
          }
          setCustomOpen(false);
          onChange({ ...presetPeriod(next, today), preset: next });
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
            value={draft.from}
            onChange={(e) => {
              onChange({ ...draft, from: e.target.value, preset: null });
            }}
          />
          <Label htmlFor="periodo-hasta" className="text-xs text-muted-foreground">
            Hasta
          </Label>
          <Input
            id="periodo-hasta"
            type="date"
            className="h-8 w-auto"
            value={draft.to}
            onChange={(e) => {
              onChange({ ...draft, to: e.target.value, preset: null });
            }}
          />
        </div>
      )}
      {valid && (
        <span className="text-sm text-muted-foreground">
          {formatPeriodRange({ from: draft.from, to: draft.to })}
        </span>
      )}
    </div>
  );
}

/**
 * cc47 (D-615): lo que la línea estándar dice del periodo aplicado, junto al botón «Filtros»: el
 * rango escrito y, mientras carga otro periodo, «Actualizando…». No es un filtro: solo informa.
 */
export function PeriodStatus({
  state,
  updating = false,
}: {
  state: ReportPeriodState;
  updating?: boolean;
}) {
  return (
    <>
      {state.valid && (
        <span className="text-sm text-muted-foreground" data-testid="periodo-rango">
          {formatPeriodRange(state.period)}
        </span>
      )}
      {updating && (
        <span role="status" className="text-sm text-muted-foreground" data-testid="actualizando">
          Actualizando…
        </span>
      )}
    </>
  );
}

/**
 * cc47 (D-615): el botón «Filtros» de un reporte cuyo único filtro es el periodo. Un reporte con
 * más filtros arma su propio `FiltersDialog` con `PeriodFields` dentro.
 */
export function PeriodFiltersButton({ state }: { state: ReportPeriodState }) {
  return (
    <FiltersDialog<PeriodDraft>
      value={periodDraftOf(state)}
      empty={defaultPeriodDraft()}
      activeCount={periodIsFiltered(state) ? 1 : 0}
      validate={periodDraftError}
      onApply={(d) => {
        state.setPeriod({ from: d.from, to: d.to }, d.preset);
      }}
    >
      {(draft, update) => <PeriodFields draft={draft} onChange={update} />}
    </FiltersDialog>
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
  }, [complete, search, setUrl]);

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

/** cc47 (D-615): el mes del reporte como borrador del modal «Filtros». */
export interface MonthDraft {
  mes: string;
}

/**
 * cc47 (D-615): el mes dentro del modal — «Este mes», «Mes anterior» y «Otro mes…», sobre un
 * borrador que no cambia la URL hasta «Aplicar».
 */
export function MonthFields({
  draft,
  onChange,
}: {
  draft: MonthDraft;
  onChange: (next: MonthDraft) => void;
}) {
  const today = businessToday();
  const matched = draft.mes === '' ? null : matchMonthPreset(draft.mes, today);
  const [customOpen, setCustomOpen] = useState(matched === null);
  const value: MonthPickerValue = customOpen || matched === null ? 'custom' : matched;
  const period = monthError(draft.mes) === null ? fullMonth(draft.mes) : null;
  return (
    <div className="grid gap-2" data-testid="periodo">
      <Segmented<MonthPickerValue>
        label="Mes"
        showLabel
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
          onChange({ mes: presetMonth(next, today) });
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
            value={draft.mes}
            onChange={(e) => {
              onChange({ mes: e.target.value });
            }}
          />
        </div>
      )}
      {period && <span className="text-sm text-muted-foreground">{formatPeriodRange(period)}</span>}
    </div>
  );
}

/** cc47 (D-615): el botón «Filtros» de un reporte cuyo único filtro es el mes. */
export function MonthFiltersButton({ state }: { state: ReportMonthState }) {
  const thisMonth = presetMonth('this-month', businessToday());
  return (
    <FiltersDialog<MonthDraft>
      value={{ mes: state.month }}
      empty={{ mes: thisMonth }}
      activeCount={state.complete && state.month !== thisMonth ? 1 : 0}
      validate={(d) => (d.mes === '' ? 'Elige un mes.' : monthError(d.mes))}
      onApply={(d) => {
        state.setMonth(d.mes);
      }}
    >
      {(draft, update) => <MonthFields draft={draft} onChange={update} />}
    </FiltersDialog>
  );
}

/** cc47 (D-615): el mes aplicado y «Actualizando…», junto al botón «Filtros». */
export function MonthStatus({
  state,
  updating = false,
}: {
  state: ReportMonthState;
  updating?: boolean;
}) {
  return (
    <>
      {state.valid && (
        <span className="text-sm text-muted-foreground" data-testid="periodo-rango">
          {formatPeriodRange(fullMonth(state.month))}
        </span>
      )}
      {updating && (
        <span role="status" className="text-sm text-muted-foreground" data-testid="actualizando">
          Actualizando…
        </span>
      )}
    </>
  );
}
