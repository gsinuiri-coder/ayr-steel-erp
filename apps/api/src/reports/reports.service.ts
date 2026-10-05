import { Injectable } from '@nestjs/common';
import { CoilStatus, Prisma } from '@prisma/client';
import {
  CoilFilmState,
  Decimal,
  businessMonth,
  endOfMonth,
  startOfMonth,
  startOfNextMonth,
  toDateOnly,
  toDecimal,
  type CoilFilmEventType,
  type CoilMonthReportDto,
  type CoilMonthReportQuery,
  type CoilMonthReportRowDto,
  type CoilMonthReportSectionDto,
} from '@ayr/shared';
import { fromDbLineCode } from '../common/business-line-code';
import { monthEndTable } from '../coils/coil-film';
import { PrismaService } from '../prisma/prisma.service';

/** Una fila cruda del reporte mensual, tal como la devuelve la consulta agregada. */
interface CoilMonthRow {
  id: string;
  code: string;
  type_key: string;
  kind: string;
  business_line_code: string;
  color_name: string | null;
  width_mm: Prisma.Decimal;
  weight_kg: Prisma.Decimal;
  unit_cost_per_kg: Prisma.Decimal;
  status: string;
  operation_date: Date;
  opening_kg: Prisma.Decimal;
  closing_kg: Prisma.Decimal;
  closing_value: Prisma.Decimal;
  /** D-328: tipo del último evento de film con `operation_date` hasta el fin de mes. */
  last_film_event: string | null;
  /** D-340: fecha del primer movimiento de kardex de la bobina (de cualquier mes), o `null`. */
  first_movement_date: Date | null;
  /** D-355: entradas del mes que no son reversas (altas). */
  entries_kg: Prisma.Decimal;
  /** D-355: fecha de la reversa de entrada más reciente (la anulación, si está anulada). */
  annulled_on: Date | null;
}

/**
 * Reportes con corte mensual (adelanto de la Fase 7f que D-124 habilita).
 *
 * Los dos saldos salen del kardex y **no** de `inventory_balances`: ese caché es el saldo de
 * hoy y no sabe de meses. Sumar los movimientos por `operationDate` es lo único que puede
 * responder "cuánto había el 1 de agosto", y es exactamente lo que no se podía preguntar
 * antes de que la fecha de operación existiera.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async coilsByMonth(query: CoilMonthReportQuery, showCosts: boolean): Promise<CoilMonthReportDto> {
    const month = query.month ?? businessMonth();
    const from = startOfMonth(month);
    const nextFrom = startOfNextMonth(month);
    // D-249: la consulta compara contra `bl."code"::text`, que es la **etiqueta** del enum de
    // Postgres —el valor de `@map`— y esa es exactamente la forma que ya tiene
    // `query.businessLine`. Traducirla con `toPrismaLineCode` la convertía en el **nombre** de
    // Prisma (`'DRYWALL'`), y la comparación `'drywall' = 'DRYWALL'` era falsa siempre: el
    // filtro devolvía cero filas para cualquier línea. Ver D-245.
    const lineCode = query.businessLine ?? null;

    // Una sola consulta agregada: con una por bobina, un mes con doscientas bobinas eran
    // doscientos viajes a Neon para una pantalla que se abre a diario.
    //
    // D-328: además del saldo y su valor, trae el **último evento de film hasta el fin de mes**
    // (`LATERAL ... LIMIT 1`, con el índice `(coil_id, operation_date, at)`), que es lo que
    // decide en cuál de las dos tablas cae la bobina. El estado del film de hoy no sirve: el
    // reporte de agosto tiene que decir lo que pasaba el 31 de agosto.
    const rows = await this.prisma.$queryRaw<CoilMonthRow[]>`
      SELECT
        c."id",
        c."code",
        c."type_key",
        c."kind"::text            AS "kind",
        bl."code"::text           AS "business_line_code",
        col."name"                AS "color_name",
        c."width_mm",
        c."weight_kg",
        c."unit_cost_per_kg",
        c."status"::text          AS "status",
        c."operation_date",
        COALESCE(SUM(
          CASE WHEN m."operation_date" < ${toDateOnly(from)}::date
               THEN CASE m."type" WHEN 'IN' THEN m."qty" WHEN 'OUT' THEN -m."qty" ELSE 0 END
               ELSE 0 END
        ), 0) AS "opening_kg",
        COALESCE(SUM(
          CASE WHEN m."operation_date" < ${toDateOnly(nextFrom)}::date
               THEN CASE m."type" WHEN 'IN' THEN m."qty" WHEN 'OUT' THEN -m."qty" ELSE 0 END
               ELSE 0 END
        ), 0) AS "closing_kg",
        -- El valor sigue la misma regla que el kardex (InventoryService.findMovements): las
        -- entradas suman su valor, las salidas lo restan y un ADJUST mueve valor sin cantidad.
        COALESCE(SUM(
          CASE WHEN m."operation_date" < ${toDateOnly(nextFrom)}::date
               THEN CASE m."type" WHEN 'OUT' THEN -m."total_cost" ELSE m."total_cost" END
               ELSE 0 END
        ), 0) AS "closing_value",
        ev."type" AS "last_film_event",
        MIN(m."operation_date") AS "first_movement_date",
        -- D-355: altas del mes (entradas que no son reversas) y fecha de la anulación: la reversa
        -- más reciente de una entrada, que solo se lee cuando la bobina está anulada (RF-21 y la
        -- reversa de un partido anulan revirtiendo su entrada).
        COALESCE(SUM(
          CASE WHEN m."operation_date" >= ${toDateOnly(from)}::date
                AND m."operation_date" < ${toDateOnly(nextFrom)}::date
                AND m."type" = 'IN' AND m."reversal_of_id" IS NULL
               THEN m."qty" ELSE 0 END
        ), 0) AS "entries_kg",
        MAX(CASE WHEN m."type" = 'OUT' AND m."reversal_of_id" IS NOT NULL
                 THEN m."operation_date" END) AS "annulled_on"
      FROM "coils" c
      JOIN "business_lines" bl ON bl."id" = c."business_line_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      LEFT JOIN "inventory_movements" m
        ON m."item_type" = 'COIL' AND m."item_id" = c."id"
      LEFT JOIN LATERAL (
        SELECT e."type"::text AS "type"
        FROM "coil_film_events" e
        WHERE e."coil_id" = c."id"
          AND e."operation_date" < ${toDateOnly(nextFrom)}::date
        ORDER BY e."operation_date" DESC, e."at" DESC, e."id" DESC
        LIMIT 1
      ) ev ON true
      -- D-340: la bobina entra al reporte del mes de su **primer movimiento de kardex** y en todos
      -- los siguientes, no del mes de su fecha de alta (ver coilInMonth): sin filtro por fecha
      -- acá, el filtro está en TypeScript para poder probarlo.
      WHERE (${lineCode}::text IS NULL OR bl."code"::text = ${lineCode}::text)
      GROUP BY c."id", bl."code", col."name", ev."type"
      ORDER BY c."code" ASC
    `;

    const sealed = emptySection();
    const opened = emptySection();
    const accum = { sealed: emptyTotals(), opened: emptyTotals() };
    // D-355: lo que no se lista suma igual al total general, para que el cuadre no cambie.
    const unlisted = emptyTotals();
    const finished = { count: 0, consumed: new Decimal(0) };
    const annulled = { count: 0, opening: new Decimal(0) };
    let entries = new Decimal(0);

    for (const r of rows) {
      if (!coilInMonth(r.first_movement_date, toDateOnly(nextFrom))) continue;
      const opening = toDecimal(r.opening_kg.toString());
      const closing = toDecimal(r.closing_kg.toString());
      const weight = toDecimal(r.weight_kg.toString());
      const value = toDecimal(r.closing_value.toString());
      const monthEntries = toDecimal(r.entries_kg.toString());
      const presence = monthPresence({
        status: r.status as CoilStatus,
        openingKg: opening,
        entriesKg: monthEntries,
        closingKg: closing,
        annulledOn: r.annulled_on,
        from: toDateOnly(from),
        nextFrom: toDateOnly(nextFrom),
      });
      // Una anulada en el mismo mes de su alta entra y sale: no está en ningún lado. Sus kilos
      // son 0 al inicio y al cierre; su valor también, salvo un residuo de redondeo del kardex,
      // que sigue sumando al valor general para que ese total no cambie respecto de D-340.
      if (presence === 'ANNULLED_SAME_MONTH' || presence === 'ABSENT') {
        unlisted.value = unlisted.value.plus(value);
        continue;
      }
      entries = entries.plus(monthEntries);
      if (presence !== 'LISTED') {
        unlisted.opening = unlisted.opening.plus(opening);
        unlisted.weight = unlisted.weight.plus(weight);
        unlisted.closing = unlisted.closing.plus(closing);
        unlisted.value = unlisted.value.plus(value);
        if (presence === 'FINISHED') {
          finished.count += 1;
          finished.consumed = finished.consumed.plus(opening.plus(monthEntries).minus(closing));
        } else {
          annulled.count += 1;
          annulled.opening = annulled.opening.plus(opening);
        }
        continue;
      }
      const table = monthEndTable({
        status: r.status as CoilStatus,
        lastEventType: r.last_film_event as CoilFilmEventType | null,
        closingKg: closing.toFixed(3),
      });
      const target = table === CoilFilmState.SEALED ? sealed : opened;
      const totals = table === CoilFilmState.SEALED ? accum.sealed : accum.opened;
      totals.opening = totals.opening.plus(opening);
      totals.weight = totals.weight.plus(weight);
      totals.closing = totals.closing.plus(closing);
      totals.value = totals.value.plus(value);
      target.rows.push(toRowDto(r, opening, weight, closing, value, showCosts));
    }

    sealed.totals = toTotalsDto(accum.sealed, showCosts);
    opened.totals = toTotalsDto(accum.opened, showCosts);
    const general = {
      opening: accum.sealed.opening.plus(accum.opened.opening).plus(unlisted.opening),
      weight: accum.sealed.weight.plus(accum.opened.weight).plus(unlisted.weight),
      closing: accum.sealed.closing.plus(accum.opened.closing).plus(unlisted.closing),
      value: accum.sealed.value.plus(accum.opened.value).plus(unlisted.value),
    };

    return {
      month,
      businessLine: query.businessLine ?? null,
      from,
      to: endOfMonth(month),
      sealed,
      opened,
      totals: toTotalsDto(general, showCosts),
      finished: { count: finished.count, consumedKg: finished.consumed.toFixed(3) },
      annulledWithOpening: { count: annulled.count, openingKg: annulled.opening.toFixed(3) },
      flow: {
        openingKg: general.opening.toFixed(3),
        entriesKg: entries.toFixed(3),
        exitsKg: general.opening.plus(entries).minus(general.closing).toFixed(3),
        closingKg: general.closing.toFixed(3),
      },
    };
  }
}

/** D-355: cómo figura una bobina en el reporte de un mes. */
export type MonthPresence =
  /** Vigente al último día del mes (saldo final > 0): va en «Selladas» o «Abiertas». */
  | 'LISTED'
  /** Terminó el mes en cero sin ser anulación: terminada o agotada; se resume abajo. */
  | 'FINISHED'
  /** Anulada en el mes con saldo al inicio: se resume abajo con ese saldo. */
  | 'ANNULLED_WITH_OPENING'
  /** Anulada en el mismo mes de su alta: entra y sale, no figura. */
  | 'ANNULLED_SAME_MONTH'
  /** Sin saldo ni movimiento en el mes (terminada o anulada antes): no figura. */
  | 'ABSENT';

/**
 * D-355: el reporte lista solo lo vigente al último día del mes, **por el saldo** y no por el
 * estado de hoy (la bobina no guarda la fecha en que se terminó): una bobina terminada después
 * figura como vigente en los meses en que tenía saldo, y una con saldo 0 sin terminar se resume
 * como agotada. La fecha de una anulación es la de la reversa de su entrada.
 */
export function monthPresence(facts: {
  status: CoilStatus;
  openingKg: Decimal;
  entriesKg: Decimal;
  closingKg: Decimal;
  annulledOn: Date | null;
  from: Date;
  nextFrom: Date;
}): MonthPresence {
  if (facts.closingKg.gt(0)) return 'LISTED';
  const annulledInMonth =
    facts.status === CoilStatus.CANCELLED &&
    facts.annulledOn !== null &&
    facts.annulledOn.getTime() >= facts.from.getTime() &&
    facts.annulledOn.getTime() < facts.nextFrom.getTime();
  if (annulledInMonth) {
    return facts.openingKg.gt(0) ? 'ANNULLED_WITH_OPENING' : 'ANNULLED_SAME_MONTH';
  }
  if (facts.openingKg.gt(0) || facts.entriesKg.gt(0)) return 'FINISHED';
  return 'ABSENT';
}

/**
 * D-340: ¿la bobina pertenece al reporte de un mes? Sí cuando su **primer movimiento de kardex** cae
 * antes del primer día del mes siguiente. Era su fecha de alta (`coils.operation_date`), y con ella el
 * saldo final de un mes dejaba de coincidir con el inicial del siguiente: D-285 fechó el 2026-08-01
 * los movimientos de la carga de V-4, pero la fecha de alta de esas bobinas quedó en septiembre, así
 * que agosto no las contaba y septiembre las traía con saldo inicial (46 805 kg de diferencia). El
 * saldo de una bobina en una fecha es la suma de sus movimientos hasta ella: incluirla exactamente
 * cuando tiene alguno anterior al corte hace que `cierre(M) = inicio(M+1)` valga siempre.
 */
export function coilInMonth(firstMovementDate: Date | null, nextMonthStart: Date): boolean {
  return firstMovementDate !== null && firstMovementDate.getTime() < nextMonthStart.getTime();
}

interface Accum {
  opening: Decimal;
  weight: Decimal;
  closing: Decimal;
  value: Decimal;
}

function emptyTotals(): Accum {
  return {
    opening: new Decimal(0),
    weight: new Decimal(0),
    closing: new Decimal(0),
    value: new Decimal(0),
  };
}

function emptySection(): CoilMonthReportSectionDto {
  return { rows: [], totals: toTotalsDto(emptyTotals(), false) };
}

function toTotalsDto(a: Accum, showCosts: boolean): CoilMonthReportSectionDto['totals'] {
  return {
    openingKg: a.opening.toFixed(3),
    weightKg: a.weight.toFixed(3),
    closingKg: a.closing.toFixed(3),
    closingValuePen: showCosts ? a.value.toFixed(4) : null,
  };
}

function toRowDto(
  r: CoilMonthRow,
  opening: Decimal,
  weight: Decimal,
  closing: Decimal,
  value: Decimal,
  showCosts: boolean,
): CoilMonthReportRowDto {
  return {
    id: r.id,
    code: r.code,
    typeKey: r.type_key,
    kind: r.kind as CoilMonthReportRowDto['kind'],
    // D-249: `fromDbLineCode` y no `toSharedLineCode`, porque el valor viene de una
    // consulta cruda. `toSharedLineCode` indexa por el nombre de Prisma y devolvía
    // `undefined` para todas las filas: la clave desaparecía del JSON sin error.
    businessLine: fromDbLineCode(r.business_line_code),
    colorName: r.color_name,
    widthMm: r.width_mm.toFixed(2),
    openingKg: opening.toFixed(3),
    weightKg: weight.toFixed(3),
    closingKg: closing.toFixed(3),
    unitCostPerKg: showCosts ? r.unit_cost_per_kg.toFixed(4) : null,
    closingValuePen: showCosts ? value.toFixed(4) : null,
    status: r.status as CoilMonthReportRowDto['status'],
    operationDate: r.operation_date.toISOString().slice(0, 10),
  };
}
