import { BadRequestException } from '@nestjs/common';
import { Decimal, roundTo } from '@ayr/shared';
import type { StripAllocation } from './production-math';

/**
 * cc34 (B1) — de qué bobina sale el despunte de un cierre de coberturas o accesorios.
 *
 * Hasta acá el cierre sumaba lo declarado de **todos** los partes, le restaba lo que salió y
 * repartía el exceso en orden de montaje (`allocateStripKg`), sin mirar de qué bobina vino cada
 * parte. Con A montada primero y B después, si B declaraba 120 kg sobre 100 de teórico, los 20 kg
 * salían de A. Y el piso era global: un parte de menos en A tapaba el despunte real de B.
 *
 * La regla nueva (decisión del dueño, cc34):
 * - **Declarado por parte:** el exceso de cada bobina sale de sus propios partes,
 *   `max(Σ declarado − Σ salida, 0)`, sin compensar entre bobinas. La bobina de cada parte es la de
 *   su salida de kardex (`COIL OUT`, `refType PRODUCTION`, `refId` del parte). Un parte que sacó
 *   de dos bobinas reparte su exceso en proporción a lo que sacó de cada una (D-539).
 * - **Total escrito al cerrar** (`consumedKg` / `closeConsumedKg`) con más de una bobina viva: el
 *   exceso sobre lo reportado se reparte en proporción a los kilos reportados de cada bobina.
 * - En los dos casos, cada bobina recibe su parte **con tope en su saldo** montado; lo que no entra
 *   pasa a las otras bobinas vivas con saldo, en orden de montaje (D-539).
 * - **Con una sola bobina viva, el resultado es el de siempre.**
 *
 * Es pura para poder probarla sin base: el servicio le pasa lo que ya cargaba.
 */

export interface RoofingScrapRow {
  consumptionId: string;
  coilId: string;
  coilCode: string;
  /** `assignedKg − consumedKg` de esa fila montada, nunca negativo. */
  remainingKg: Decimal;
}

export interface RoofingScrapReport {
  id: string;
  /** Lo que planta declaró en ese parte (D-146); `null` si no declaró. */
  declaredKg: Decimal | null;
  /** Cuenta como salida si el parte no tiene ninguna en el kardex (no debería pasar). */
  theoreticalKg?: Decimal;
}

export interface RoofingScrapOut {
  reportId: string;
  coilId: string;
  kg: Decimal;
}

export interface RoofingScrapInput {
  /** Las filas vivas de la orden, **en orden de montaje**. */
  rows: readonly RoofingScrapRow[];
  reports: readonly RoofingScrapReport[];
  /** Las salidas vivas de bobina de esos partes. */
  outs: readonly RoofingScrapOut[];
  /** El total escrito al cerrar; `null` si no se escribió. */
  explicitTotalKg: Decimal | null;
}

export interface RoofingScrapResult {
  /** Lo que los partes sacaron de las bobinas (el piso de D-089/D-246). */
  reportedKg: Decimal;
  /** El consumo de la corrida: lo reportado más el despunte. */
  declaredKg: Decimal;
  scrapKg: Decimal;
  /** Por fila montada, en orden de montaje. */
  allocations: StripAllocation[];
}

const ZERO = new Decimal(0);

function sum(values: Iterable<Decimal>): Decimal {
  let acc = ZERO;
  for (const v of values) acc = acc.plus(v);
  return acc;
}

function addTo(map: Map<string, Decimal>, key: string, kg: Decimal): void {
  map.set(key, (map.get(key) ?? ZERO).plus(kg));
}

/**
 * Reparte `totalKg` entre las claves en proporción a `weights`, en gramos (3 decimales). Cada
 * cuota se **trunca** hacia cero y el resto va a la clave de más peso (la primera, si empatan):
 * así la suma cierra exacta y ninguna cuota cambia de signo por el redondeo (revisión de cc34:
 * redondear al medio y darle el resto a la última dejaba esa cuota negativa con 4 bobinas).
 */
function splitProportionally(
  totalKg: Decimal,
  weights: ReadonlyMap<string, Decimal>,
): Map<string, Decimal> {
  const keys = [...weights.keys()].filter((k) => (weights.get(k) ?? ZERO).gt(0));
  const weightSum = sum(keys.map((k) => weights.get(k) ?? ZERO));
  const shares = new Map<string, Decimal>();
  if (keys.length === 0 || weightSum.lte(0)) return shares;
  let heaviest = keys[0] ?? '';
  for (const key of keys) {
    shares.set(
      key,
      totalKg
        .times(weights.get(key) ?? ZERO)
        .div(weightSum)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN),
    );
    if ((weights.get(key) ?? ZERO).gt(weights.get(heaviest) ?? ZERO)) heaviest = key;
  }
  const rest = totalKg.minus(sum(shares.values()));
  shares.set(heaviest, (shares.get(heaviest) ?? ZERO).plus(rest));
  return shares;
}

export function allocateRoofingScrap(input: RoofingScrapInput): RoofingScrapResult {
  const liveCoils: string[] = [];
  const capacity = new Map<string, Decimal>();
  for (const row of input.rows) {
    if (!capacity.has(row.coilId)) liveCoils.push(row.coilId);
    addTo(capacity, row.coilId, row.remainingKg);
  }
  const remainingKg = sum(capacity.values());

  // Lo que sacó cada parte, por bobina. Un parte sin salida cuenta su teórico en la primera bobina
  // viva: el piso nunca baja por un dato ausente (mismo criterio que `reportsOutKg`).
  const outsByReport = new Map<string, Map<string, Decimal>>();
  for (const out of input.outs) {
    const perCoil = outsByReport.get(out.reportId) ?? new Map<string, Decimal>();
    addTo(perCoil, out.coilId, out.kg);
    outsByReport.set(out.reportId, perCoil);
  }
  const reportOuts = input.reports.map((report) => {
    const perCoil = outsByReport.get(report.id);
    if (perCoil !== undefined) return { report, perCoil };
    const fallback = new Map<string, Decimal>();
    fallback.set(liveCoils[0] ?? '', report.theoreticalKg ?? ZERO);
    return { report, perCoil: fallback };
  });

  const reportedByCoil = new Map<string, Decimal>();
  for (const { perCoil } of reportOuts) {
    for (const [coilId, kg] of perCoil) addTo(reportedByCoil, coilId, kg);
  }
  const reportedKg = sum(reportedByCoil.values());

  // El despunte que le toca a cada bobina, antes del tope por saldo.
  const targets = new Map<string, Decimal>();
  if (input.explicitTotalKg !== null) {
    const declared = input.explicitTotalKg;
    if (declared.lt(reportedKg)) {
      throw new BadRequestException(
        `Las planchas reportadas ya consumieron ${reportedKg.toFixed(3)} kg: no se puede declarar un consumo de ${declared.toFixed(3)} kg`,
      );
    }
    const excess = roundTo(declared.minus(reportedKg), 'KG');
    const liveReported = new Map(
      liveCoils.map((coilId) => [coilId, reportedByCoil.get(coilId) ?? ZERO] as const),
    );
    // Con una sola bobina viva, o sin nada reportado en las vivas, el orden de montaje de siempre.
    const shares =
      liveCoils.length > 1 ? splitProportionally(excess, liveReported) : new Map<string, Decimal>();
    if (shares.size === 0 && excess.gt(0)) shares.set(liveCoils[0] ?? '', excess);
    for (const [coilId, kg] of shares) addTo(targets, coilId, kg);
  } else if (liveCoils.length <= 1) {
    // Una bobina: el piso global de siempre (D-146), lo declarado o lo que salió, lo que sea mayor.
    const declaredByReports = sum(
      reportOuts.map(({ report, perCoil }) => report.declaredKg ?? sum(perCoil.values())),
    );
    const excess = roundTo(Decimal.max(declaredByReports.minus(reportedKg), ZERO), 'KG');
    if (excess.gt(0)) targets.set(liveCoils[0] ?? '', excess);
  } else {
    // Varias bobinas: cada parte carga su exceso (o su defecto) a la bobina de la que salió.
    const netByCoil = new Map<string, Decimal>();
    for (const { report, perCoil } of reportOuts) {
      if (report.declaredKg === null) continue;
      const delta = report.declaredKg.minus(sum(perCoil.values()));
      if (delta.isZero()) continue;
      for (const [coilId, kg] of splitProportionally(delta, perCoil)) {
        addTo(netByCoil, coilId, kg);
      }
    }
    for (const [coilId, net] of netByCoil) {
      const excess = roundTo(Decimal.max(net, ZERO), 'KG');
      if (excess.gt(0)) targets.set(coilId, excess);
    }
  }

  const scrapKg = sum(targets.values());
  const declaredKg = reportedKg.plus(scrapKg);
  // D-089: no más de lo que la orden tiene montado.
  if (scrapKg.gt(remainingKg)) {
    throw new BadRequestException(
      `La orden tiene ${reportedKg.plus(remainingKg).toFixed(3)} kg montados y se declaran ${declaredKg.toFixed(3)} kg consumidos: monta más material o corrige la cifra`,
    );
  }

  // Cada bobina con tope en su saldo; lo que no entra, a las otras vivas en orden de montaje.
  const placed = new Map<string, Decimal>();
  let overflow = ZERO;
  for (const [coilId, kg] of targets) {
    const room = capacity.get(coilId) ?? ZERO;
    const take = Decimal.min(kg, room);
    if (take.gt(0)) addTo(placed, coilId, take);
    overflow = overflow.plus(kg.minus(take));
  }
  for (const coilId of liveCoils) {
    if (overflow.lte(0)) break;
    const room = (capacity.get(coilId) ?? ZERO).minus(placed.get(coilId) ?? ZERO);
    if (room.lte(0)) continue;
    const take = Decimal.min(room, overflow);
    addTo(placed, coilId, take);
    overflow = overflow.minus(take);
  }

  // De la bobina a sus filas montadas, en orden de montaje.
  const allocations: StripAllocation[] = [];
  const pendingByCoil = new Map(placed);
  for (const row of input.rows) {
    const pending = pendingByCoil.get(row.coilId) ?? ZERO;
    if (pending.lte(0) || row.remainingKg.lte(0)) continue;
    const kg = Decimal.min(row.remainingKg, pending);
    allocations.push({
      consumptionId: row.consumptionId,
      coilId: row.coilId,
      coilCode: row.coilCode,
      kg,
    });
    pendingByCoil.set(row.coilId, pending.minus(kg));
  }

  // Red: lo que sale al kardex es exactamente el despunte que la orden y la reserva registran.
  const allocatedKg = sum(allocations.map((a) => a.kg));
  if (!allocatedKg.equals(scrapKg) || allocations.some((a) => a.kg.lte(0))) {
    throw new BadRequestException(
      `El reparto del despunte entre las bobinas no cierra (${allocatedKg.toFixed(3)} de ${scrapKg.toFixed(3)} kg)`,
    );
  }

  return { reportedKg, declaredKg, scrapKg, allocations };
}
