import {
  Decimal,
  piecesCount,
  piecesMeters,
  roofingPlanGap,
  toDecimal,
  type PieceLike,
  type RoofingPieceDto,
} from '@ayr/shared';
import { byLength } from './production-blocks';

/**
 * cc38 (D-573, D-575, D-576) — el avance de una orden y si se puede cerrar. Lógica pura, sin React:
 * la usan la pantalla de coberturas (a medida y plancha) y la del accesorio.
 *
 * - **Registrado**: lo de los reportes vigentes.
 * - **En borrador, sin registrar**: lo que escribió el supervisor (guardado o por guardar), sin el
 *   bloque que se llenó solo y todavía no se confirmó (D-575: ese no cuenta hasta confirmarlo).
 * - **Falta**: el plan menos lo anterior.
 * - **Para cerrar** se cuenta también el bloque llenado solo: «Registrar y cerrar» lo pide confirmar
 *   en «Qué va a pasar» (tablero `CerrarBarra`). La orden se cierra solo con el plan completo: los
 *   metros totales iguales a los del plan con tres decimales, como en el API (D-573).
 */

export interface ProgressPart {
  meters: Decimal;
  /** Planchas, cuando aplica (no en un accesorio, ni si no se pueden contar). */
  pieces: number | null;
}

export interface PlanProgressView {
  plan: ProgressPart;
  registered: ProgressPart;
  draft: ProgressPart;
  missing: ProgressPart;
  /** Lo que falta por largo, si se puede calcular sin negativos y cuadra con los metros. */
  missingDetail: RoofingPieceDto[] | null;
  /** Metros del bloque que se llenó solo, sin confirmar. */
  autoMeters: Decimal;
  /** Lo que falta para cerrar contando el bloque llenado solo. */
  toClose: Decimal;
  /** Lo registrado más el borrador (y el bloque llenado solo) pasa el plan. */
  excess: Decimal;
  /** Registrado + borrador + bloque llenado solo = plan, sin pasarse, y hay algo. */
  canClose: boolean;
  /** Para cerrar hace falta confirmar el bloque llenado solo. */
  needsAutoConfirm: boolean;
  /** Ancho de cada tramo de la barra, en % del plan (sumados nunca pasan 100). */
  bar: { registered: number; draft: number };
}

export interface PlanProgressInput {
  planMeters: string;
  reportedMeters: string;
  /** `null` en un accesorio: no lleva planchas. */
  plan: {
    items: readonly PieceLike[];
    remainingPieces: readonly PieceLike[];
    reportedPieces: number;
  } | null;
  /** Lo escrito y confirmado: largos (cobertura) o metros (accesorio). */
  draft: readonly PieceLike[] | Decimal;
  /** El bloque llenado solo, sin confirmar: largos o metros. */
  auto: readonly PieceLike[] | Decimal;
}

const ZERO = new Decimal(0);

function metersOf(value: readonly PieceLike[] | Decimal): Decimal {
  return value instanceof Decimal ? value : piecesMeters(value);
}

function percent(part: Decimal, whole: Decimal): number {
  if (whole.lte(0)) return 0;
  return Decimal.min(Decimal.max(part.div(whole).times(100), ZERO), new Decimal(100)).toNumber();
}

export function planProgress(input: PlanProgressInput): PlanProgressView {
  const planMeters = toDecimal(input.planMeters);
  const registeredMeters = toDecimal(input.reportedMeters);
  const draftMeters = metersOf(input.draft);
  const autoMeters = metersOf(input.auto);
  const missingMeters = Decimal.max(planMeters.minus(registeredMeters).minus(draftMeters), ZERO);
  const gap = roofingPlanGap(planMeters, registeredMeters.plus(draftMeters).plus(autoMeters));

  let missingDetail: RoofingPieceDto[] | null = null;
  if (input.plan !== null && !(input.draft instanceof Decimal)) {
    const inDraft = byLength(input.draft);
    const detail: RoofingPieceDto[] = [];
    let negative = false;
    for (const [lengthMm, qty] of byLength(input.plan.remainingPieces)) {
      const left = qty - (inDraft.get(lengthMm) ?? 0);
      inDraft.delete(lengthMm);
      if (left < 0) negative = true;
      if (left > 0) detail.push({ lineNumber: detail.length + 1, lengthMm, qty: left });
    }
    // Un largo del borrador que lo que falta no tiene, o un detalle que no da los metros que
    // faltan (se registraron otros largos), no se puede mostrar por largo sin mentir.
    if (!negative && inDraft.size === 0 && piecesMeters(detail).equals(missingMeters)) {
      missingDetail = detail;
    }
  }

  const draftPieces =
    input.plan === null || input.draft instanceof Decimal ? null : piecesCount(input.draft);
  const something = registeredMeters.plus(draftMeters).plus(autoMeters).gt(0);
  const canClose = gap.missing.isZero() && gap.excess.isZero() && something;
  return {
    plan: {
      meters: planMeters,
      pieces: input.plan === null ? null : piecesCount(input.plan.items),
    },
    registered: {
      meters: registeredMeters,
      pieces: input.plan === null ? null : input.plan.reportedPieces,
    },
    draft: { meters: draftMeters, pieces: draftPieces },
    missing: {
      meters: missingMeters,
      pieces: missingDetail === null ? null : piecesCount(missingDetail),
    },
    missingDetail,
    autoMeters,
    toClose: gap.missing,
    excess: gap.excess,
    canClose,
    needsAutoConfirm: canClose && autoMeters.gt(0),
    bar: (() => {
      const registered = percent(registeredMeters, planMeters);
      return {
        registered,
        draft: Math.min(percent(draftMeters, planMeters), 100 - registered),
      };
    })(),
  };
}
