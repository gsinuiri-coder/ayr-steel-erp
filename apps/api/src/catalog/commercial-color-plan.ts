import { commercialColorToken, Decimal, toDecimal } from '@ayr/shared';

/**
 * El plan del paso de `colorId` exacto a **color comercial** en producción y reservas
 * (diseño `docs/diseno/color-comercial-produccion.md`, D-270 en adelante).
 *
 * Aritmética pura, sin base: el dry-run (`prisma/color-comercial-dry-run.ts`) lee los datos y
 * esto decide qué specs se funden, cuáles se parten, qué agregado queda corto, qué OP deja de
 * coincidir y cuánto se mueve el piso de precio. Vive en `src` y no junto al guion para que
 * jest lo cubra: una cuenta equivocada acá es una ventana que se corre con números falsos.
 */

/** Tipo de acabado, con los mismos literales que el enum `FinishKind` de Prisma. */
export type PlanFinishKind = 'NATURAL' | 'PREPINTADO' | 'GALVANIZADO';

/**
 * La misma regla que `commercialColorToken`, en SQL, sobre la columna `code`. Es la que siembra
 * `colors.commercial_color` en la migración; el dry-run la corre contra cada color y la compara
 * fila por fila con la función de TS (riesgo 3 del diseño). Un centinela verifica que la
 * migración la contenga **textual**.
 *
 * `translate` y no `unaccent`: la extensión no está instalada y la migración no la crea. Cubre
 * las vocales con tilde o diéresis y la eñe; cualquier otro signo lo quita el último
 * `regexp_replace`, igual que la función de TS.
 */
export const COMMERCIAL_COLOR_SQL = `regexp_replace(upper(translate(regexp_replace(btrim("code"), '[-\\s]*(RAL)?[-\\s]*\\d{3,4}$', '', 'i'), 'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ', 'aeiouunAEIOUUNaeiouAEIOU')), '[^A-Z0-9]', '', 'g')`;

/** El atributo de material de un acabado: el color comercial si es prepintado, el tipo si no. */
export function materialKeyOf(kind: PlanFinishKind, commercialColor: string | null): string | null {
  if (kind !== 'PREPINTADO') return kind;
  return commercialColor === null || commercialColor === '' ? null : commercialColor;
}

export interface PlanColor {
  id: string;
  code: string;
  name: string;
  ralCode: string | null;
  /** Lo que da la expresión SQL de la migración sobre este código. */
  sqlCommercialColor: string;
}

export interface PlanColorRow extends PlanColor {
  /** Lo que da `commercialColorToken` (TS). */
  commercialColor: string;
  /** SQL y TS difieren: la migración no puede sembrarse. */
  mismatch: boolean;
  /** Queda vacío: el código es solo un RAL y no dice el color comercial. */
  empty: boolean;
}

export function planColors(colors: PlanColor[]): PlanColorRow[] {
  return colors.map((c) => {
    const commercialColor = commercialColorToken(c.code);
    return {
      ...c,
      commercialColor,
      mismatch: commercialColor !== c.sqlCommercialColor,
      empty: commercialColor === '',
    };
  });
}

/** Una bobina `COIL` abierta, con lo que el agregado necesita de ella. */
export interface PlanCoil {
  id: string;
  code: string;
  businessLineId: string;
  thicknessMm: string;
  colorId: string | null;
  kind: PlanFinishKind;
  commercialColor: string | null;
  ralCode: string | null;
  balanceKg: string;
  avgCostPen: string;
  /** Lo que una corrida a stock retiene de ella (D-154). Cero si nace de un pedido. */
  heldKg: string;
  /** Reserva por ítem sobre la bobina entera (RF-73). */
  reservedOnCoilKg: string;
}

/** Una reserva viva (firme o temporal vigente) contra una spec. */
export interface PlanReservation {
  id: string;
  temporary: boolean;
  specId: string;
  qtyKg: string;
  /** `PED-000012` o `COT-000034`. */
  documentCode: string;
  /** El documento (pedido o cotización) que la hizo. */
  documentId: string;
  productSku: string;
  /** Tipo y color comercial del producto de la línea que reservó. */
  productKind: PlanFinishKind | null;
  productCommercialColor: string | null;
  productColorId: string | null;
}

export interface PlanSpec {
  id: string;
  businessLineId: string;
  colorId: string | null;
  thicknessMm: string;
  /** Líneas de cotización y pedido (de cualquier estado) que la nombran en `reserve_item_id`. */
  quotationLines: number;
  salesOrderLines: number;
  /** Tipos de producto de esas líneas, para partir una spec sin color. */
  lineKinds: PlanFinishKind[];
}

export interface PlanInput {
  colors: PlanColorRow[];
  coils: PlanCoil[];
  specs: PlanSpec[];
  reservations: PlanReservation[];
  toleranceMm: string;
}

/** La llave nueva de una spec: `línea|atributo|espesor`. */
export function groupKey(businessLineId: string, materialKey: string, thicknessMm: string): string {
  return `${businessLineId}|${materialKey}|${thicknessMm}`;
}

function coilMaterialKey(coil: PlanCoil): string | null {
  return materialKeyOf(coil.kind, coil.commercialColor);
}

function withinTolerance(a: string, b: string, tolerance: Decimal): boolean {
  return toDecimal(a).minus(toDecimal(b)).abs().lte(tolerance);
}

/** La disponibilidad de un conjunto de bobinas contra lo prometido, igual que D-134/D-154. */
export interface Availability {
  coilCodes: string[];
  physicalKg: Decimal;
  reservedOnCoilsKg: Decimal;
  reservedGenericKg: Decimal;
  availableKg: Decimal;
}

function availabilityOf(coils: PlanCoil[], genericKg: Decimal): Availability {
  let physical = new Decimal(0);
  let onCoils = new Decimal(0);
  for (const c of coils) {
    const free = Decimal.max(toDecimal(c.balanceKg).minus(toDecimal(c.heldKg)), new Decimal(0));
    physical = physical.plus(free);
    if (free.gt(0)) onCoils = onCoils.plus(toDecimal(c.reservedOnCoilKg));
  }
  return {
    coilCodes: coils.map((c) => c.code).sort(),
    physicalKg: physical,
    reservedOnCoilsKg: onCoils,
    reservedGenericKg: genericKg,
    availableKg: physical.minus(onCoils).minus(genericKg),
  };
}

function sumKg(rows: { qtyKg: string }[]): Decimal {
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.qtyKg)), new Decimal(0));
}

/** Un agregado de la regla nueva y las specs viejas que lo forman. */
export interface PlanGroup {
  key: string;
  businessLineId: string;
  materialKey: string;
  thicknessMm: string;
  /** Specs viejas que caen en este grupo (una sin color puede aparecer en dos). */
  sourceSpecIds: string[];
  reservations: PlanReservation[];
  before: Availability[];
  after: Availability;
  /** Disponible antes (suma de las specs de origen) — para mostrar cuánto cambia. */
  availableBeforeKg: Decimal;
}

export interface SpecSplit {
  specId: string;
  /** Tipos que la nombran: con dos, la spec se parte. */
  kinds: PlanFinishKind[];
}

export interface PlanAnomaly {
  kind:
    | 'RESERVATION_KEY_UNKNOWN'
    | 'RESERVATION_COLOR_MISMATCH'
    | 'SPEC_COLOR_UNKNOWN'
    | 'SPEC_KIND_UNKNOWN';
  detail: string;
}

export interface PlanResult {
  groups: PlanGroup[];
  /** Grupos con más de una spec de origen: la migración las funde. */
  merges: PlanGroup[];
  /** Specs sin color nombradas por productos de los dos tipos. */
  splits: SpecSplit[];
  /** Grupos cuyo disponible queda negativo después y no lo era antes. */
  newShortfalls: PlanGroup[];
  anomalies: PlanAnomaly[];
  /** Qué grupo le toca a cada spec vieja, por tipo cuando se parte. */
  groupBySpec: Map<string, string[]>;
  /** El disponible de cada spec vieja bajo la regla de hoy. */
  beforeBySpec: Map<string, Availability>;
}

/**
 * El plan entero: agrupa las specs viejas por la llave nueva y calcula el disponible antes y
 * después.
 *
 * La reserva **viaja con su producto**, no con su spec: la llave nueva sale del tipo y el color
 * comercial del producto de la línea que reservó. Así se parte una spec sin color en NATURAL y
 * GALVANIZADO sin adivinar, y una reserva cuyo producto ya no coincide con su spec (alguien
 * cambió el color del producto) aparece como anomalía en vez de mudarse en silencio.
 */
export function buildPlan(input: PlanInput): PlanResult {
  const tolerance = toDecimal(input.toleranceMm);
  const colorById = new Map(input.colors.map((c) => [c.id, c]));
  const anomalies: PlanAnomaly[] = [];
  const specById = new Map(input.specs.map((s) => [s.id, s]));

  const openCoilsOf = (lineId: string, thicknessMm: string): PlanCoil[] =>
    input.coils.filter(
      (c) => c.businessLineId === lineId && withinTolerance(c.thicknessMm, thicknessMm, tolerance),
    );

  // La llave nueva de cada spec vieja. Con color: su color comercial. Sin color: los tipos de
  // los productos que la nombran (en líneas de cualquier estado, y en reservas vivas).
  const groupBySpec = new Map<string, string[]>();
  const splits: SpecSplit[] = [];
  for (const spec of input.specs) {
    if (spec.colorId !== null) {
      const color = colorById.get(spec.colorId);
      if (!color || color.commercialColor === '') {
        anomalies.push({
          kind: 'SPEC_COLOR_UNKNOWN',
          detail: `spec ${spec.id}: el color ${color?.code ?? spec.colorId} no tiene color comercial`,
        });
        continue;
      }
      groupBySpec.set(spec.id, [
        groupKey(spec.businessLineId, color.commercialColor, spec.thicknessMm),
      ]);
      continue;
    }
    const kinds = new Set<PlanFinishKind>(spec.lineKinds.filter((k) => k !== 'PREPINTADO'));
    for (const r of input.reservations) {
      if (r.specId === spec.id && r.productKind !== null && r.productKind !== 'PREPINTADO') {
        kinds.add(r.productKind);
      }
    }
    const sorted = [...kinds].sort();
    if (sorted.length === 0) {
      anomalies.push({
        kind: 'SPEC_KIND_UNKNOWN',
        detail: `spec ${spec.id} (sin color, ${spec.thicknessMm} mm): ningún producto dice su tipo`,
      });
      continue;
    }
    if (sorted.length > 1) splits.push({ specId: spec.id, kinds: sorted });
    groupBySpec.set(
      spec.id,
      sorted.map((k) => groupKey(spec.businessLineId, k, spec.thicknessMm)),
    );
  }

  // Cada reserva, a su grupo nuevo según su producto.
  const reservationsByGroup = new Map<string, PlanReservation[]>();
  for (const r of input.reservations) {
    const spec = specById.get(r.specId);
    if (!spec) continue;
    const key = materialKeyOf(r.productKind ?? 'PREPINTADO', r.productCommercialColor);
    if (r.productKind === null || key === null) {
      anomalies.push({
        kind: 'RESERVATION_KEY_UNKNOWN',
        detail: `${r.documentCode} (${r.productSku}): el producto no tiene acabado con tipo o color comercial`,
      });
      continue;
    }
    if (r.productColorId !== spec.colorId) {
      anomalies.push({
        kind: 'RESERVATION_COLOR_MISMATCH',
        detail: `${r.documentCode} (${r.productSku}): el color del producto no es el de la spec que reservó`,
      });
    }
    const gk = groupKey(spec.businessLineId, key, spec.thicknessMm);
    const list = reservationsByGroup.get(gk) ?? [];
    list.push(r);
    reservationsByGroup.set(gk, list);
  }

  // Los grupos: todas las llaves que alguna spec o alguna reserva produce.
  const groupMeta = new Map<
    string,
    { businessLineId: string; materialKey: string; thicknessMm: string; specs: Set<string> }
  >();
  for (const spec of input.specs) {
    for (const gk of groupBySpec.get(spec.id) ?? []) {
      const [, materialKey = ''] = gk.split('|');
      const meta = groupMeta.get(gk) ?? {
        businessLineId: spec.businessLineId,
        materialKey,
        thicknessMm: spec.thicknessMm,
        specs: new Set<string>(),
      };
      meta.specs.add(spec.id);
      groupMeta.set(gk, meta);
    }
  }

  const specAvailabilityBefore = new Map<string, Availability>();
  for (const spec of input.specs) {
    const coils = openCoilsOf(spec.businessLineId, spec.thicknessMm).filter(
      (c) => c.colorId === spec.colorId,
    );
    const generic = sumKg(input.reservations.filter((r) => r.specId === spec.id));
    specAvailabilityBefore.set(spec.id, availabilityOf(coils, generic));
  }

  const groups: PlanGroup[] = [];
  for (const [key, meta] of groupMeta) {
    const coils = openCoilsOf(meta.businessLineId, meta.thicknessMm).filter(
      (c) => coilMaterialKey(c) === meta.materialKey,
    );
    const reservations = reservationsByGroup.get(key) ?? [];
    const before = [...meta.specs].flatMap((id) => {
      const a = specAvailabilityBefore.get(id);
      return a ? [a] : [];
    });
    groups.push({
      key,
      businessLineId: meta.businessLineId,
      materialKey: meta.materialKey,
      thicknessMm: meta.thicknessMm,
      sourceSpecIds: [...meta.specs].sort(),
      reservations,
      before,
      after: availabilityOf(coils, sumKg(reservations)),
      availableBeforeKg: before.reduce((acc, a) => acc.plus(a.availableKg), new Decimal(0)),
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));

  const newShortfalls = groups.filter(
    (g) => g.after.availableKg.lt(0) && !g.before.some((a) => a.availableKg.lt(0)),
  );

  return {
    groups,
    merges: groups.filter((g) => g.sourceSpecIds.length > 1),
    splits,
    newShortfalls,
    anomalies,
    groupBySpec,
    beforeBySpec: specAvailabilityBefore,
  };
}

/** Una OP de coberturas viva con una bobina montada. */
export interface PlanMountedCoil {
  orderCode: string;
  productSku: string;
  productColorId: string | null;
  productKind: PlanFinishKind | null;
  productCommercialColor: string | null;
  coilCode: string;
  coilColorId: string | null;
  coilKind: PlanFinishKind;
  coilCommercialColor: string | null;
}

export interface MountedCheck extends PlanMountedCoil {
  matchesBefore: boolean;
  matchesAfter: boolean;
}

/** ¿La bobina montada sigue coincidiendo con el producto bajo cada regla? */
export function checkMounted(rows: PlanMountedCoil[]): MountedCheck[] {
  return rows.map((r) => ({
    ...r,
    matchesBefore: r.coilColorId === r.productColorId,
    matchesAfter:
      r.productKind !== null &&
      materialKeyOf(r.coilKind, r.coilCommercialColor) ===
        materialKeyOf(r.productKind, r.productCommercialColor),
  }));
}

/** Costo por kg ponderado por los kilos, como `unitCosts` del piso (D-163). */
export function weightedCostPerKg(coils: PlanCoil[]): Decimal {
  let kilos = new Decimal(0);
  let value = new Decimal(0);
  for (const c of coils) {
    const qty = toDecimal(c.balanceKg);
    if (qty.lte(0)) continue;
    kilos = kilos.plus(qty);
    value = value.plus(qty.times(toDecimal(c.avgCostPen)));
  }
  return kilos.lte(0) ? new Decimal(0) : value.div(kilos);
}

/** Las bobinas que el piso lee bajo cada regla (misma línea, espesor en tolerancia). */
export function floorCoils(
  coils: PlanCoil[],
  line: { businessLineId: string; thicknessMm: string; colorId: string | null },
  materialKey: string | null,
  toleranceMm: string,
): { before: PlanCoil[]; after: PlanCoil[] } {
  const tolerance = toDecimal(toleranceMm);
  const near = coils.filter(
    (c) =>
      c.businessLineId === line.businessLineId &&
      withinTolerance(c.thicknessMm, line.thicknessMm, tolerance),
  );
  return {
    before: near.filter((c) => c.colorId === line.colorId),
    after: materialKey === null ? [] : near.filter((c) => coilMaterialKey(c) === materialKey),
  };
}
