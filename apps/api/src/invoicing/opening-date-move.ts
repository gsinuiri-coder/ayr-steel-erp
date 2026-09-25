import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@ayr/shared';
import { firstNegativeDate, type PlanItemKardex } from './invoice-dispatch-plan';

/**
 * D-285: la fecha efectiva del inventario inicial, decidida por el dueño.
 *
 * La carga inicial (`refType = 'IMPORT'`) quedó fechada el día en que se cargó —15-09 las
 * bobinas, 22-09 el UPVC—, pero el conteo representa el stock al comienzo de la historia que el
 * sistema registra: las ventas de agosto sí lo consumieron. Se fecha el `HISTORICAL_LOAD_START`
 * (2026-08-01). Es la **única** excepción a la regla append-only del kardex: cambia solo
 * `operation_date` de esos movimientos (cantidades, costos y `at` quedan), una vez, auditada
 * movimiento por movimiento.
 */
export const OPENING_MOVE_DATE = '2026-08-01';
export const OPENING_MOVE_ACTION = 'inventory.opening-date.move';
export const OPENING_MOVE_REASON =
  'fecha efectiva del inventario inicial = inicio de la carga histórica (D-285, decisión del dueño)';

export interface OpeningItem {
  key: string;
  label: string;
  /** Los movimientos de carga inicial del ítem (id del movimiento y fecha de operación). */
  imports: { id: string; date: string }[];
  /** La fecha del primer movimiento del ítem que no es carga inicial, o null. */
  earliestOther: string | null;
}

export interface OpeningMove {
  key: string;
  label: string;
  movementIds: string[];
  from: string[];
  to: string;
  action: 'MOVE' | 'SKIP' | 'ALREADY';
  reason: string | null;
}

export function planOpeningMoves(items: readonly OpeningItem[], target: string): OpeningMove[] {
  return items.map((it) => {
    const base = {
      key: it.key,
      label: it.label,
      movementIds: it.imports.map((m) => m.id),
      from: it.imports.map((m) => m.date),
      to: target,
    };
    if (it.imports.every((m) => m.date === target)) {
      return { ...base, action: 'ALREADY', reason: null };
    }
    // Un movimiento anterior a la fecha efectiva quedaría antes del saldo inicial: ese ítem no
    // se mueve (lo decidió el dueño: la condición es por ítem).
    if (it.earliestOther !== null && it.earliestOther < target) {
      return {
        ...base,
        action: 'SKIP',
        reason: `Tiene movimientos anteriores a ${target} (el primero, del ${it.earliestOther})`,
      };
    }
    return { ...base, action: 'MOVE', reason: null };
  });
}

/** La guarda de código: la excepción no se puede repetir. */
export function assertOpeningMoveNotApplied(alreadyApplied: boolean): void {
  if (alreadyApplied) {
    throw new BadRequestException(
      'La fecha del inventario inicial ya se aplicó (D-285): la excepción no se repite.',
    );
  }
}

export interface MissingOut {
  /** La línea del despacho sin salida de kardex. */
  id: string;
  itemKey: string;
  /** Fecha del despacho, que es la de la salida. */
  date: string;
  qty: Decimal;
}

export interface PlannedMissingOut extends MissingOut {
  action: 'ADD' | 'REVIEW';
  reason: string | null;
}

/**
 * Qué líneas de despacho sin salida la reciben ahora: las que el kardex (con la carga inicial
 * ya refechada) sostiene en toda fecha, acumulando en orden de fecha. Lo que no, a revisión.
 */
export function planMissingOuts(
  missing: readonly MissingOut[],
  kardexByItem: ReadonlyMap<string, PlanItemKardex>,
  /**
   * Autorrevisión P1-1: saldo de hoy menos lo reservado vivo, por ítem. `InventoryService.record`
   * rechaza una salida que deje el saldo por debajo de lo reservado; el plan lo anticipa.
   * Sin entrada para un ítem, no se limita.
   */
  headroom: ReadonlyMap<string, Decimal> = new Map(),
): PlannedMissingOut[] {
  const used = new Map<string, Decimal>();
  const accepted = new Map<string, { date: string; qty: Decimal }[]>();
  return [...missing]
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1))
    .map((m) => {
      const kardex = kardexByItem.get(m.itemKey) ?? { openingDate: null, movements: [] };
      if (kardex.openingDate !== null && m.date < kardex.openingDate) {
        return {
          ...m,
          action: 'REVIEW',
          reason: `Sigue antes del inventario inicial (${kardex.openingDate})`,
        };
      }
      const outs = accepted.get(m.itemKey) ?? [];
      const candidate = [...outs, { date: m.date, qty: m.qty }];
      const negativeOn = firstNegativeDate(kardex.movements, candidate);
      if (negativeOn !== null) {
        return {
          ...m,
          action: 'REVIEW',
          reason: `Una salida el ${m.date} deja el kardex negativo el ${negativeOn}`,
        };
      }
      const room = headroom.get(m.itemKey);
      const spent = (used.get(m.itemKey) ?? new Decimal(0)).plus(m.qty);
      if (room !== undefined && spent.gt(room)) {
        return {
          ...m,
          action: 'REVIEW',
          reason: `El saldo no cubre lo reservado vivo: quedan ${room.toFixed(3)} libres y las salidas suman ${spent.toFixed(3)}`,
        };
      }
      used.set(m.itemKey, spent);
      accepted.set(m.itemKey, candidate);
      return { ...m, action: 'ADD', reason: null };
    });
}

/** Las salidas aceptadas por ítem, para sumarlas al plan de despacho que sigue. */
export function acceptedOuts(
  planned: readonly PlannedMissingOut[],
): Map<string, { date: string; qty: Decimal }[]> {
  const out = new Map<string, { date: string; qty: Decimal }[]>();
  for (const p of planned) {
    if (p.action !== 'ADD') continue;
    out.set(p.itemKey, [...(out.get(p.itemKey) ?? []), { date: p.date, qty: p.qty }]);
  }
  return out;
}
