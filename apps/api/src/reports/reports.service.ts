import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  businessMonth,
  endOfMonth,
  startOfMonth,
  startOfNextMonth,
  toDateOnly,
  toDecimal,
  type CoilMonthReportDto,
  type CoilMonthReportQuery,
  type CoilMonthReportRowDto,
} from '@ayr/shared';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
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
    const lineCode = query.businessLine ? toPrismaLineCode(query.businessLine) : null;

    // Una sola consulta agregada: con una por bobina, un mes con doscientas bobinas eran
    // doscientos viajes a Neon para una pantalla que se abre a diario.
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
        ), 0) AS "closing_kg"
      FROM "coils" c
      JOIN "business_lines" bl ON bl."id" = c."business_line_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      LEFT JOIN "inventory_movements" m
        ON m."item_type" = 'COIL' AND m."item_id" = c."id"
      -- La bobina entra al reporte del mes en que se dio de alta y en todos los siguientes:
      -- una comprada en agosto sigue siendo saldo inicial de septiembre.
      WHERE c."operation_date" < ${toDateOnly(nextFrom)}::date
        AND (${lineCode}::text IS NULL OR bl."code"::text = ${lineCode}::text)
      GROUP BY c."id", bl."code", col."name"
      ORDER BY c."code" ASC
    `;

    let openingTotal = new Decimal(0);
    let weightTotal = new Decimal(0);
    let closingTotal = new Decimal(0);

    const dtos: CoilMonthReportRowDto[] = rows.map((r) => {
      const opening = toDecimal(r.opening_kg.toString());
      const closing = toDecimal(r.closing_kg.toString());
      const weight = toDecimal(r.weight_kg.toString());
      openingTotal = openingTotal.plus(opening);
      weightTotal = weightTotal.plus(weight);
      closingTotal = closingTotal.plus(closing);
      return {
        id: r.id,
        code: r.code,
        typeKey: r.type_key,
        kind: r.kind as CoilMonthReportRowDto['kind'],
        businessLine: toSharedLineCode(
          r.business_line_code as Parameters<typeof toSharedLineCode>[0],
        ),
        colorName: r.color_name,
        widthMm: r.width_mm.toFixed(2),
        openingKg: opening.toFixed(3),
        weightKg: weight.toFixed(3),
        closingKg: closing.toFixed(3),
        unitCostPerKg: showCosts ? r.unit_cost_per_kg.toFixed(4) : null,
        status: r.status as CoilMonthReportRowDto['status'],
        operationDate: r.operation_date.toISOString().slice(0, 10),
      };
    });

    return {
      month,
      from,
      to: endOfMonth(month),
      rows: dtos,
      totals: {
        openingKg: openingTotal.toFixed(3),
        weightKg: weightTotal.toFixed(3),
        closingKg: closingTotal.toFixed(3),
      },
    };
  }
}
