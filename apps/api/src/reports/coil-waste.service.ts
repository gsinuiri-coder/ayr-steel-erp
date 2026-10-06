import { Injectable } from '@nestjs/common';
import {
  BusinessLine,
  fromDateOnly,
  toDateOnly,
  toDecimal,
  toleranceOverrideLabel,
  type CoilWasteDto,
  type CoilWasteQuery,
} from '@ayr/shared';
import { toPrismaLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  TOLERANCE_OVERRIDE_AUDIT_ACTION,
  toleranceOverrideAuditSchema,
} from '../production/production-shared';
import {
  assembleCoilWaste,
  type WasteCoil,
  type WasteMovement,
  type WasteReport,
  type WasteToleranceOverride,
} from './coil-waste';

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
      this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: {
          id: true,
          code: true,
          kind: true,
          typeKey: true,
          widthMm: true,
          status: true,
          color: { select: { name: true } },
        },
      }),
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
              action: TOLERANCE_OVERRIDE_AUDIT_ACTION,
            },
            select: { after: true },
          });

    const coils = new Map<string, WasteCoil>(
      coilRows.map((c) => [
        c.id,
        {
          code: c.code,
          kind: c.kind,
          typeKey: c.typeKey,
          colorName: c.color?.name ?? null,
          widthMm: c.widthMm.toFixed(2),
          status: c.status,
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
    // D-388/D-389: la casilla vive en la auditoría de la orden, no en una columna.
    const overrides = new Map<string, WasteToleranceOverride>();
    for (const row of auditRows) {
      const parsed = toleranceOverrideAuditSchema.safeParse(row.after);
      if (!parsed.success) continue;
      const { reportId, reason, detail, differencePct } = parsed.data;
      overrides.set(reportId, {
        label: toleranceOverrideLabel({ reason, ...(detail === null ? {} : { detail }) }),
        excessPct: differencePct,
      });
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
