import {
  Decimal,
  mountedKgForReport,
  piecesMeters,
  piecesTheoreticalKg,
  roofingConsumptionDeviation,
  toDecimal,
  type MountedKgExcess,
  type PieceLike,
  type RoofingBatchCoilDto,
  type RoofingPieceDto,
} from '@ayr/shared';

/**
 * cc35 (ESPEC §1) — el modelo M de «Producir una OP»: **un bloque por bobina, en el orden en que
 * se montaron**. Lógica pura, sin React, para que la pantalla y sus pruebas cuenten igual.
 *
 * Un bloque es una fila del borrador de la orden (D-191): bobina, cortes (largo × planchas) y kg
 * consumidos. Las cuentas son las del API: la salida de kardex de un bloque es su teórico, topado en
 * lo montado (D-246, `mountedKgForReport`); el despunte es lo declarado menos esa salida, y cae en
 * **esa** bobina al cerrar (cc34, D-539).
 */

const ZERO = new Decimal(0);

function keyOf(lengthMm: string): string {
  return toDecimal(lengthMm).toFixed(2);
}

/** Planchas por largo (clave en mm con dos decimales). */
export function byLength(pieces: readonly PieceLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pieces) out.set(keyOf(p.lengthMm), (out.get(keyOf(p.lengthMm)) ?? 0) + p.qty);
  return out;
}

/**
 * **El último bloque se llena solo con lo que falta del plan**: lo que el plan todavía debe
 * (`remainingPieces`, ya descontado lo reportado) menos lo que llevan los otros bloques, por largo,
 * en el orden del plan. Un largo que los otros bloques ya cubren no aparece.
 */
export function fillFromRemaining(
  remaining: readonly PieceLike[],
  others: readonly (readonly PieceLike[])[],
): RoofingPieceDto[] {
  const taken = byLength(others.flat());
  const out: RoofingPieceDto[] = [];
  for (const p of remaining) {
    const key = keyOf(p.lengthMm);
    const used = taken.get(key) ?? 0;
    const left = p.qty - used;
    taken.set(key, Math.max(used - p.qty, 0));
    if (left > 0) out.push({ lineNumber: out.length + 1, lengthMm: key, qty: left });
  }
  return out;
}

export interface BlockFigures {
  meters: Decimal;
  theoreticalKg: Decimal;
  /** Lo que el bloque saca de la bobina al registrarse: el teórico, topado en lo montado (D-246). */
  outKg: Decimal;
  /** Lo declarado en «kg consumidos», o `null` si se dejó vacío (vale el teórico). */
  declaredKg: Decimal | null;
  /** Despunte de esta bobina: lo declarado menos lo que sale, nunca negativo. */
  scrapKg: Decimal;
  /** Lo que le queda montado a la bobina después del bloque. */
  leftKg: Decimal;
  /** «Se terminó»: no le queda nada montado. */
  terminated: boolean;
  /** D-388/D-389: pasa lo montado más del 1 % del teórico; hace falta la casilla con motivo. */
  excess: MountedKgExcess | null;
  /** Lo que el API también rechaza: el bloque no se puede guardar así. */
  error: string | null;
  /** D-154: «revisa que no falte un dígito», cuando lo declarado se aleja más del 10 %. */
  deviation: string | null;
  /** D-246: el teórico pasa lo montado dentro de la tolerancia; avisa y no bloquea. */
  note: string | null;
}

const KG_PATTERN = /^\d+(\.\d{1,3})?$/;

/** Las cifras de un bloque: metros, teórico, despunte, lo que queda y sus avisos. */
export function blockFigures(
  coil: Pick<
    RoofingBatchCoilDto,
    'coilCode' | 'widthMm' | 'thicknessMm' | 'densityFactor' | 'remainingKg'
  >,
  pieces: readonly PieceLike[],
  consumedKg: string,
): BlockFigures {
  const meters = piecesMeters(pieces);
  const theoreticalKg = piecesTheoreticalKg(coil, pieces);
  const available = toDecimal(coil.remainingKg);
  const raw = consumedKg.trim();
  const base: BlockFigures = {
    meters,
    theoreticalKg,
    outKg: ZERO,
    declaredKg: null,
    scrapKg: ZERO,
    leftKg: available,
    terminated: available.lte(0),
    excess: null,
    error: null,
    deviation: null,
    note: null,
  };
  if (raw !== '' && (!KG_PATTERN.test(raw) || toDecimal(raw).lte(0))) {
    return { ...base, error: 'Los kilos van con hasta tres decimales y mayores a cero.' };
  }
  const declaredKg = raw === '' ? null : toDecimal(raw);
  if (pieces.length === 0) {
    return {
      ...base,
      declaredKg,
      ...(declaredKg?.gt(available) === true
        ? {
            error: `${coil.coilCode} tiene ${available.toFixed(3)} kg montados y se declaran ${declaredKg.toFixed(3)} kg consumidos.`,
          }
        : {}),
    };
  }
  const mounted = mountedKgForReport({
    label: coil.coilCode,
    theoreticalKg,
    availableKg: available,
    declaredKg: raw === '' ? null : raw,
    overrideBands: { authorized: true },
  });
  if (!mounted.ok) return { ...base, declaredKg, error: mounted.message };
  if (declaredKg?.gt(available) === true) {
    return {
      ...base,
      declaredKg,
      error: `${coil.coilCode} tiene ${available.toFixed(3)} kg montados y se declaran ${declaredKg.toFixed(3)} kg consumidos: corrige la cifra.`,
    };
  }
  const outKg = mounted.kg;
  const scrapKg = declaredKg === null ? ZERO : Decimal.max(declaredKg.minus(outKg), ZERO);
  const leftKg = Decimal.max(available.minus(outKg).minus(scrapKg), ZERO);
  return {
    ...base,
    outKg,
    declaredKg,
    scrapKg,
    leftKg,
    terminated: leftKg.lte(0),
    excess: mounted.overridden ? mounted.excess : null,
    note: mounted.overridden ? null : mounted.note,
    deviation:
      declaredKg === null
        ? null
        : roofingConsumptionDeviation({
            declaredKg,
            theoreticalKg,
            alreadyDeclaredKg: '0',
            planKg: null,
          }),
  };
}

/**
 * «Fila N: …» del commit (D-191) → la bobina de esa fila, para mostrar el error **en su bloque**.
 * `null` si el mensaje no nombra una fila o la fila no existe.
 */
export function coilOfRowError(
  message: string,
  drafts: readonly { rowNumber: number; coilId: string }[],
): string | null {
  const match = /^Fila (\d+): /.exec(message);
  if (match === null) return null;
  const row = Number(match[1]);
  return drafts.find((d) => d.rowNumber === row)?.coilId ?? null;
}

/** El mensaje sin el «Fila N: » del commit: en el bloque ya se sabe de qué bobina es. */
export function withoutRowPrefix(message: string): string {
  return message.replace(/^Fila \d+: /, '');
}

export interface PlanSquare {
  /** Planchas del plan. */
  planned: number;
  /** Planchas cubiertas: reportadas + las de los bloques, sin pasar lo que pide cada largo. */
  covered: number;
  /** Cada largo completo y ninguno de más: la franja va en verde. */
  complete: boolean;
}

/**
 * La franja de cuadre: «N de N planchas del plan, cada largo completo». Reportado + bloques contra
 * el plan, largo por largo. Un largo de más (o que el plan no tiene) deja la franja sin cuadrar.
 */
export function planSquare(
  planItems: readonly PieceLike[],
  remainingPieces: readonly PieceLike[],
  blocks: readonly (readonly PieceLike[])[],
): PlanSquare {
  const plan = byLength(planItems);
  const left = byLength(remainingPieces);
  const inBlocks = byLength(blocks.flat());
  let planned = 0;
  let covered = 0;
  let complete = true;
  for (const [key, qty] of plan) {
    const done = qty - (left.get(key) ?? 0) + (inBlocks.get(key) ?? 0);
    planned += qty;
    covered += Math.min(done, qty);
    if (done !== qty) complete = false;
  }
  for (const key of inBlocks.keys()) if (!plan.has(key)) complete = false;
  return { planned, covered, complete };
}
