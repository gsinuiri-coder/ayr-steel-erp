import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BusinessLine,
  fromDateOnly,
  toDateOnly,
  toDecimal,
  type CoilWasteDto,
  type CoilWasteQuery,
} from '@ayr/shared';
import { toPrismaLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  readToleranceOverrideAudit,
  TOLERANCE_OVERRIDE_AUDIT_ACTIONS,
} from '../production/production-shared';
import {
  assembleCoilWaste,
  type WasteCoil,
  type WasteMovement,
  type WasteReport,
  type WasteToleranceOverride,
} from './coil-waste';

/** Una bobina del rango, con su acabado y su color (cc39: una sola sentencia). */
interface CoilRow {
  id: string;
  code: string;
  kind: string;
  type_key: string;
  width_mm: Prisma.Decimal;
  status: string;
  finish_name: string;
  color_name: string | null;
}

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433..D-436). Merma por bobina. Solo lectura y solo
 * administrador (D-426, en el controlador): no escribe kardex ni cambia cómo se calcula el costo.
 *
 * **Consultas fijas**, sin importar cuántas bobinas o reportes haya: los movimientos del rango
 * (una), las bobinas, los reportes y las autorizaciones de tolerancia (una cada una, y ninguna
 * si no hay bobinas en el rango). Cuatro como máximo. D-436: no se mira la venta de la bobina.
 */
@Injectable()
export class CoilWasteService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: CoilWasteQuery): Promise<CoilWasteDto> {
    const businessLine = query.businessLine ?? BusinessLine.METALLIC_ROOFING;
    const base = { from: query.from, to: query.to, businessLine };

    // D-429: los movimientos vivos del rango (el criterio de D-291: ni anulados ni la anulación
    // de otro), de la línea de la pestaña.
    const rawMovements = await this.prisma.inventoryMovement.findMany({
      where: {
        itemType: 'COIL',
        refType: { in: ['PRODUCTION', 'SCRAP', 'CLOSE_ADJUSTMENT'] },
        operationDate: { gte: toDateOnly(query.from), lte: toDateOnly(query.to) },
        businessLine: { code: toPrismaLineCode(businessLine) },
        reversalOfId: null,
        reversals: { none: {} },
      },
      select: {
        itemId: true,
        type: true,
        qty: true,
        refType: true,
        refId: true,
        operationDate: true,
      },
      orderBy: { id: 'asc' },
    });
    const movements: WasteMovement[] = rawMovements.map((m) => ({
      itemId: m.itemId,
      type: m.type,
      qty: toDecimal(m.qty.toString()),
      refType: m.refType as WasteMovement['refType'],
      refId: m.refId,
      operationDate: fromDateOnly(m.operationDate),
    }));

    const production = movements.filter((m) => m.refType === 'PRODUCTION');
    // D-435: la bobina entra por producción, despunte o ajuste de cierre; no por la merma manual
    // sola (D-431, `SCRAP` con `refId` = la bobina).
    const coilIds = [
      ...new Set(
        movements
          .filter((m) => !(m.refType === 'SCRAP' && m.refId === m.itemId))
          .map((m) => m.itemId),
      ),
    ];
    if (coilIds.length === 0) {
      return assembleCoilWaste({
        ...base,
        movements: [],
        coils: new Map(),
        reports: new Map(),
        overrides: new Map(),
      });
    }
    const reportIds = [
      ...new Set(production.map((m) => m.refId).filter((id): id is string => isUuid(id))),
    ];

    const [coilRows, reportRows] = await Promise.all([
      // cc39 (D-582): una sola sentencia con el acabado y el color. Con `findMany` y sus
      // relaciones, Prisma manda una sentencia por relación, y sumar el acabado rompía el
      // presupuesto fijo de consultas de los Paneles (`dashboards.db-spec`).
      this.prisma.$queryRaw<CoilRow[]>`
        SELECT
          c."id",
          c."code",
          c."kind"::text   AS "kind",
          c."type_key",
          c."width_mm",
          c."status"::text AS "status",
          f."name"         AS "finish_name",
          col."name"       AS "color_name"
        FROM "coils" c
        JOIN "finishes" f ON f."id" = c."finish_id"
        LEFT JOIN "colors" col ON col."id" = c."color_id"
        WHERE c."id" = ANY(${coilIds}::uuid[])
      `,
      reportIds.length === 0
        ? Promise.resolve([])
        : this.prisma.productionReport.findMany({
            where: { id: { in: reportIds } },
            select: {
              id: true,
              theoreticalKg: true,
              operationDate: true,
              productionOrderId: true,
              productionOrder: { select: { seq: true } },
            },
          }),
    ]);

    const orderIds = [...new Set(reportRows.map((r) => r.productionOrderId))];
    const auditRows =
      orderIds.length === 0
        ? []
        : await this.prisma.auditLog.findMany({
            where: {
              entity: 'production_orders',
              entityId: { in: orderIds },
              action: { in: TOLERANCE_OVERRIDE_AUDIT_ACTIONS },
            },
            select: { action: true, after: true },
          });

    const coils = new Map<string, WasteCoil>(
      coilRows.map((c) => [
        c.id,
        {
          code: c.code,
          kind: c.kind as WasteCoil['kind'],
          typeKey: c.type_key,
          finishName: c.finish_name,
          colorName: c.color_name,
          widthMm: c.width_mm.toFixed(2),
          status: c.status as WasteCoil['status'],
        },
      ]),
    );
    const reports = new Map<string, WasteReport>(
      reportRows.map((r) => [
        r.id,
        {
          theoreticalKg: toDecimal(r.theoreticalKg.toString()),
          productionOrderId: r.productionOrderId,
          orderSeq: r.productionOrder.seq,
          operationDate: fromDateOnly(r.operationDate),
        },
      ]),
    );
    // D-388/D-389: la casilla vive en la auditoría de la orden, no en una columna. D-465: también
    // la de drywall, con su acción propia.
    const overrides = new Map<string, WasteToleranceOverride>();
    for (const row of auditRows) {
      const parsed = readToleranceOverrideAudit(row);
      if (parsed === null) continue;
      overrides.set(parsed.reportId, { label: parsed.label, excessPct: parsed.differencePct });
    }

    return assembleCoilWaste({
      ...base,
      movements,
      coils,
      reports,
      overrides,
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `refId` es texto libre: solo un uuid puede ser el id de un reporte. */
function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}
