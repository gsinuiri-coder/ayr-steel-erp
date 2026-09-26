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
        ev."type" AS "last_film_event"
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
      -- La bobina entra al reporte del mes en que se dio de alta y en todos los siguientes:
      -- una comprada en agosto sigue siendo saldo inicial de septiembre.
      WHERE c."operation_date" < ${toDateOnly(nextFrom)}::date
        AND (${lineCode}::text IS NULL OR bl."code"::text = ${lineCode}::text)
      GROUP BY c."id", bl."code", col."name", ev."type"
      ORDER BY c."code" ASC
    `;

    const sealed = emptySection();
    const opened = emptySection();
    const accum = { sealed: emptyTotals(), opened: emptyTotals() };

    for (const r of rows) {
      const opening = toDecimal(r.opening_kg.toString());
      const closing = toDecimal(r.closing_kg.toString());
      const weight = toDecimal(r.weight_kg.toString());
      const value = toDecimal(r.closing_value.toString());
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
      opening: accum.sealed.opening.plus(accum.opened.opening),
      weight: accum.sealed.weight.plus(accum.opened.weight),
      closing: accum.sealed.closing.plus(accum.opened.closing),
      value: accum.sealed.value.plus(accum.opened.value),
    };

    return {
      month,
      from,
      to: endOfMonth(month),
      sealed,
      opened,
      totals: toTotalsDto(general, showCosts),
    };
  }
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
