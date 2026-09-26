import { BadRequestException } from '@nestjs/common';
import { CoilStatus, type Prisma } from '@prisma/client';
import { CoilFilmEventType, CoilFilmSource, CoilFilmState, toDateOnly } from '@ayr/shared';
import { findLiveStripAssignments } from '../production/production-assignments';

type EventType = CoilFilmEventType;
type EventSource = CoilFilmSource;
type FilmState = CoilFilmState;

/**
 * D-328 — film de protección de la bobina.
 *
 * Este archivo es el único que sabe **cuándo** se abre y **cuándo** se puede volver a sellar. Las
 * decisiones puras (derivar el estado de los eventos, decidir si un resello es válido, clasificar
 * una bobina para el reporte mensual y para el backfill) están separadas de los accesos a la base
 * para poder probarlas sin una: son las cuatro reglas que el dueño fijó.
 */

/* ------------------------------------------------------------------------------------- *
 * Derivación del estado
 * ------------------------------------------------------------------------------------- */

export interface FilmEventLike {
  id: string;
  type: EventType;
  source: EventSource;
  /** `YYYY-MM-DD` (día de negocio, Lima). */
  operationDate: string;
  at: Date;
  refId?: string | null;
}

/** Orden cronológico del historial: día de negocio, luego instante de grabación, luego id. */
export function compareFilmEvents(a: FilmEventLike, b: FilmEventLike): number {
  if (a.operationDate !== b.operationDate) return a.operationDate < b.operationDate ? -1 : 1;
  const dt = a.at.getTime() - b.at.getTime();
  if (dt !== 0) return dt < 0 ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** El último evento (con `operationDate` hasta `cutoff`, si se da), o `null` si no hay ninguno. */
export function lastFilmEvent<T extends FilmEventLike>(events: T[], cutoff?: string): T | null {
  let last: T | null = null;
  for (const e of events) {
    if (cutoff !== undefined && e.operationDate > cutoff) continue;
    if (last === null || compareFilmEvents(e, last) > 0) last = e;
  }
  return last;
}

/** Estado del film según los eventos: sin eventos, o el último es «volver a sellar» → sellada. */
export function filmStateFromEvents(events: FilmEventLike[], cutoff?: string): FilmState {
  const last = lastFilmEvent(events, cutoff);
  return last?.type === CoilFilmEventType.OPENED ? CoilFilmState.OPENED : CoilFilmState.SEALED;
}

/* ------------------------------------------------------------------------------------- *
 * Volver a sellar
 * ------------------------------------------------------------------------------------- */

/** Una salida de material viva (no anulada) de la bobina, con el instante en que se grabó. */
export interface LiveOutflow {
  refType: string;
  operationDate: string;
  at: Date;
}

/** Tipos de referencia que cuentan como «usar» la bobina (D-328): producir, mermar, partir, cortar. */
export const USE_REF_TYPES = ['PRODUCTION', 'SCRAP', 'SPLIT', 'CUTTING'] as const;

const USE_LABELS: Record<string, string> = {
  PRODUCTION: 'una producción',
  SCRAP: 'una merma',
  SPLIT: 'un partido',
  CUTTING: 'un corte',
};

export interface ResealFacts {
  status: CoilStatus;
  film: FilmState;
  /** El último evento de apertura, o `null` si no hay historial. */
  lastOpen: { source: EventSource; at: Date } | null;
  /** Salidas vivas del kardex de la bobina (cualquier fecha; el filtro por apertura es de acá). */
  outflows: LiveOutflow[];
  /** Códigos de las OP vivas que la tienen montada. */
  liveOrderCodes: string[];
}

/**
 * ¿Se puede volver a sellar? Devuelve el motivo del rechazo, o `null` si sí. El motivo nombra el
 * movimiento o la OP concreta: «no se puede» no le sirve a quien tiene que arreglarlo.
 */
export function resealBlocker(facts: ResealFacts): string | null {
  if (facts.status === CoilStatus.CLOSED) {
    return 'La bobina está terminada: no se puede volver a sellar';
  }
  if (facts.status === CoilStatus.CANCELLED) {
    return 'La bobina está anulada: no se puede volver a sellar';
  }
  if (facts.status === CoilStatus.IN_THIRD_PARTY) {
    return 'La bobina está en corte tercerizado: se vuelve a sellar al cancelar el envío';
  }
  if (facts.film === CoilFilmState.SEALED) {
    return 'La bobina ya está sellada';
  }
  if (facts.lastOpen?.source === CoilFilmSource.BIRTH) {
    return 'La bobina nació abierta (hija de un partido o fleje de corte): no tiene film que volver a poner';
  }
  // Un evento deducido por el backfill se grabó **después** de las salidas que lo motivaron (su
  // `at` es el del backfill, su día de negocio es el de la primera salida): para esos, cualquier
  // salida viva cuenta, sin comparar instantes de grabación.
  const since =
    facts.lastOpen === null || facts.lastOpen.source === CoilFilmSource.BACKFILL
      ? null
      : facts.lastOpen.at;
  const used = facts.outflows
    .filter((o) => (USE_REF_TYPES as readonly string[]).includes(o.refType))
    .filter((o) => since === null || o.at.getTime() >= since.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (used) {
    const label = USE_LABELS[used.refType] ?? 'un movimiento';
    return `Ya salió material desde que se abrió (${label} del ${used.operationDate}): no se puede volver a sellar`;
  }
  if (facts.liveOrderCodes.length > 0) {
    return `La bobina está montada en ${facts.liveOrderCodes.join(', ')}: libérala antes de volver a sellar`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------- *
 * Reporte mensual — en qué tabla va una bobina
 * ------------------------------------------------------------------------------------- */

export interface MonthEndFacts {
  status: CoilStatus;
  /** Tipo del último evento con `operationDate` hasta el fin de mes; `null` si no hay. */
  lastEventType: EventType | null;
  /** Saldo de kardex al fin de mes, en kg. */
  closingKg: string;
}

/**
 * D-328: en qué tabla del reporte va una bobina al último día del mes.
 *
 * - **Terminada con saldo 0** → «Abiertas». Una terminada se usó (o se vendió entera): no es
 *   stock sellado, y aunque nunca haya tenido evento de apertura el reporte no la muestra entre
 *   las selladas con 0 kg. Una terminada con saldo **al fin de ese mes** todavía no lo estaba a
 *   esa fecha: se ubica por su film como cualquier otra.
 * - En cualquier otro caso, el film a esa fecha: el último evento ≤ fin de mes decide;
 *   sin eventos, sellada.
 */
export function monthEndTable(facts: MonthEndFacts): FilmState {
  if (facts.status === CoilStatus.CLOSED && isZeroKg(facts.closingKg)) return CoilFilmState.OPENED;
  return facts.lastEventType === CoilFilmEventType.OPENED
    ? CoilFilmState.OPENED
    : CoilFilmState.SEALED;
}

function isZeroKg(value: string): boolean {
  return /^-?0+(\.0+)?$/.test(value.trim());
}

/* ------------------------------------------------------------------------------------- *
 * Backfill — deducir el film del historial
 * ------------------------------------------------------------------------------------- */

export interface BackfillFacts {
  status: CoilStatus;
  /** Nació de un partido o de un corte tercerizado (`parentCoilId`). */
  bornOpen: boolean;
  /** Fecha de alta de la bobina, `YYYY-MM-DD`. */
  operationDate: string;
  /** Salidas vivas OUT del kardex de la bobina. */
  outflows: { refType: string; operationDate: string }[];
  /** Día de negocio del envío a corte que sigue `SENT`, si lo hay. */
  sentToCuttingOn: string | null;
  /** Día de negocio en que se montó en una OP viva, si lo está. */
  mountedOn: string | null;
  /** Ya tiene historial de film: el backfill no la vuelve a tocar (es idempotente). */
  hasEvents: boolean;
}

export type BackfillReason =
  'BORN_OPEN' | 'OUTFLOW' | 'IN_CUTTING' | 'MOUNTED' | 'HAS_EVENTS' | 'ONLY_SALE' | 'NO_USE';

export interface BackfillDecision {
  /** `OPEN`: se le inserta un evento `OPENED`; `KEEP`: no se le inserta nada. */
  action: 'OPEN' | 'KEEP';
  reason: BackfillReason;
  /** Solo con `OPEN`: la fecha del evento, la de la primera evidencia de uso. */
  operationDate?: string;
  source?: EventSource;
}

/**
 * Clasifica una bobina para el backfill (D-328). Regla del dueño: «Abierta» si tuvo una salida
 * viva de producción, merma, partido o corte, con el `OPENED` fechado en **la primera**; las
 * terminadas cuya única salida es una venta no reciben evento (quedan «Terminada» por estado y el
 * reporte las ubica en «Abiertas»); todo el resto, «Sellada».
 *
 * Además de lo literal: la bobina que **nació abierta** (hija de partido, fleje de corte) recibe
 * su `OPENED` de nacimiento —las nuevas ya lo llevan—, y la que hoy está enviada a corte o
 * montada en una OP viva recibe el suyo, porque montar y enviar a corte abren el film. Las tres
 * salen marcadas en el dry-run con su motivo para que el dueño pueda vetarlas.
 */
export function classifyBackfill(facts: BackfillFacts): BackfillDecision {
  if (facts.hasEvents) return { action: 'KEEP', reason: 'HAS_EVENTS' };

  const candidates: { date: string; reason: BackfillReason; source: EventSource }[] = [];
  if (facts.bornOpen) {
    candidates.push({
      date: facts.operationDate,
      reason: 'BORN_OPEN',
      source: CoilFilmSource.BIRTH,
    });
  }
  const uses = facts.outflows.filter((o) =>
    (USE_REF_TYPES as readonly string[]).includes(o.refType),
  );
  for (const o of uses) {
    candidates.push({
      date: o.operationDate,
      reason: 'OUTFLOW',
      source: CoilFilmSource.BACKFILL,
    });
  }
  if (facts.sentToCuttingOn !== null) {
    candidates.push({
      date: facts.sentToCuttingOn,
      reason: 'IN_CUTTING',
      source: CoilFilmSource.BACKFILL,
    });
  }
  if (facts.mountedOn !== null) {
    candidates.push({
      date: facts.mountedOn,
      reason: 'MOUNTED',
      source: CoilFilmSource.BACKFILL,
    });
  }

  if (candidates.length === 0) {
    const sold = facts.outflows.some((o) => o.refType === 'SALE');
    return {
      action: 'KEEP',
      reason: facts.status === CoilStatus.CLOSED && sold ? 'ONLY_SALE' : 'NO_USE',
    };
  }
  // El evento se fecha en la evidencia más temprana; a igualdad, gana la que ya estaba primero.
  const first = candidates.reduce((min, c) => (c.date < min.date ? c : min));
  return {
    action: 'OPEN',
    reason: first.reason,
    operationDate: first.date,
    source: first.source,
  };
}

/* ------------------------------------------------------------------------------------- *
 * Accesos a la base (dentro de la transacción del llamador)
 * ------------------------------------------------------------------------------------- */

export interface RecordFilmEventInput {
  coilId: string;
  type: EventType;
  source: EventSource;
  /** `YYYY-MM-DD` (Lima). */
  operationDate: string;
  actorId: string | null;
  reason?: string | null;
  refId?: string | null;
}

/**
 * Inserta un evento de film. El trigger `coil_film_events_sync` actualiza `coils.film_sealed` en
 * la misma sentencia. **Llamar antes** de los movimientos de kardex de la misma operación:
 * «salió material desde que se abrió» compara instantes de grabación (`at`), y la apertura tiene
 * que quedar antes (o en el mismo milisegundo) que la salida que la provocó.
 */
export async function recordFilmEvent(
  tx: Prisma.TransactionClient,
  input: RecordFilmEventInput,
): Promise<void> {
  await tx.coilFilmEvent.create({
    data: {
      coilId: input.coilId,
      type: input.type,
      source: input.source,
      operationDate: toDateOnly(input.operationDate),
      reason: input.reason ?? null,
      refId: input.refId ?? null,
      actorId: input.actorId,
    },
  });
}

export interface OpenFilmContext {
  source: EventSource;
  operationDate: string;
  actorId: string;
  refId?: string | null;
  reason?: string | null;
}

/**
 * Abre el film de una bobina vigente y sellada al usarla (montar, merma, partir, enviar a
 * corte). Si ya estaba abierta, o no está vigente (una terminada no lleva film que mirar), no
 * hace nada. Devuelve `true` si escribió el evento: el llamador lo usa para saber si esta
 * operación es la que abrió (y por tanto la que puede deshacerlo).
 */
export async function openFilmIfSealed(
  tx: Prisma.TransactionClient,
  coil: { id: string; status: CoilStatus; filmSealed: boolean },
  ctx: OpenFilmContext,
): Promise<boolean> {
  if (!coil.filmSealed) return false;
  if (coil.status !== CoilStatus.OPEN) return false;
  await recordFilmEvent(tx, {
    coilId: coil.id,
    type: CoilFilmEventType.OPENED,
    source: ctx.source,
    operationDate: ctx.operationDate,
    actorId: ctx.actorId,
    refId: ctx.refId ?? null,
    reason: ctx.reason ?? null,
  });
  return true;
}

/**
 * Junta los hechos de una bobina que `resealBlocker` necesita. Lee el historial, las salidas de
 * kardex vivas y las OP que la tienen montada.
 */
export async function loadResealFacts(
  tx: Prisma.TransactionClient,
  coil: { id: string; status: CoilStatus; filmSealed: boolean },
): Promise<ResealFacts> {
  const [lastOpen, movements, assignments] = await Promise.all([
    tx.coilFilmEvent.findFirst({
      where: { coilId: coil.id, type: CoilFilmEventType.OPENED },
      orderBy: [{ operationDate: 'desc' }, { at: 'desc' }, { id: 'desc' }],
      select: { source: true, at: true },
    }),
    tx.inventoryMovement.findMany({
      where: {
        itemType: 'COIL',
        itemId: coil.id,
        type: 'OUT',
        refType: { in: [...USE_REF_TYPES] },
        reversalOfId: null,
        reversals: { none: {} },
      },
      select: { refType: true, operationDate: true, at: true },
    }),
    findLiveStripAssignments(tx, [coil.id]),
  ]);
  return {
    status: coil.status,
    film: coil.filmSealed ? CoilFilmState.SEALED : CoilFilmState.OPENED,
    lastOpen,
    outflows: movements.map((m) => ({
      refType: m.refType,
      operationDate: m.operationDate.toISOString().slice(0, 10),
      at: m.at,
    })),
    liveOrderCodes: assignments.map((a) => a.orderCode),
  };
}

/** Falla con 400 si el resello no es válido; el mensaje nombra el movimiento o la OP. */
export async function assertCanReseal(
  tx: Prisma.TransactionClient,
  coil: { id: string; status: CoilStatus; filmSealed: boolean },
): Promise<void> {
  const blocker = resealBlocker(await loadResealFacts(tx, coil));
  if (blocker !== null) throw new BadRequestException(blocker);
}

/**
 * Deshace la apertura que causó una operación al deshacerla (liberar sin reportes, cancelar el
 * envío a corte). Solo resella si el último evento fue una apertura **de esa misma causa** —una
 * apertura manual, o de otra operación, no se toca— y si no hay nada que lo impida (no salió
 * material, no sigue montada en otra OP). No exige que sea el mismo consumo: una bobina montada
 * en dos OP se vuelve a sellar cuando se libera la última, que es cuando deja de estar en uso.
 * Devuelve `true` si resello.
 */
export async function resealIfOpenedBy(
  tx: Prisma.TransactionClient,
  coil: { id: string; status: CoilStatus; filmSealed: boolean },
  cause: { source: EventSource; refId: string; undoSource: EventSource },
  ctx: { operationDate: string; actorId: string },
): Promise<boolean> {
  if (coil.filmSealed) return false;
  const last = await tx.coilFilmEvent.findFirst({
    where: { coilId: coil.id },
    orderBy: [{ operationDate: 'desc' }, { at: 'desc' }, { id: 'desc' }],
    select: { type: true, source: true, refId: true },
  });
  if (last?.type !== CoilFilmEventType.OPENED || last.source !== cause.source) return false;
  // El estado de la bobina en este punto es el que tendrá al terminar la operación: al cancelar
  // un envío a corte todavía figura `IN_THIRD_PARTY`, y `resealBlocker` la rechazaría. El
  // llamador pasa el estado ya restaurado.
  const facts = await loadResealFacts(tx, coil);
  if (resealBlocker(facts) !== null) return false;
  await recordFilmEvent(tx, {
    coilId: coil.id,
    type: CoilFilmEventType.RESEALED,
    source: cause.undoSource,
    operationDate: ctx.operationDate,
    actorId: ctx.actorId,
    refId: cause.refId,
  });
  return true;
}
